import { MP4PullAudioDemuxer } from '../audio-video-player/mp4-pull-demuxer.ts'
import { RingBuffer } from '../third_party/ringbufjs/ringbuf.ts'
import { debugLog } from './debug-log.ts'
import { Defer, defer } from './defer.ts'

const DATA_BUFFER_DECODE_TARGET_DURATION = 0.3
const DATA_BUFFER_DURATION = 0.6
const DECODER_QUEUE_SIZE_MAX = 5
const ENABLE_DEBUG_LOGGING = false

export class AudioRenderer {
  fillInProgress = false
  playing = false
  interleavingBuffers: Array<Float32Array> = []

  decoder?: AudioDecoder
  sampleRate?: number
  channelCount?: number
  ringbuffer?: RingBuffer
  ready: Promise<void>
  #deferredReady: Defer<void>

  constructor(public demuxer: MP4PullAudioDemuxer) {
    const deferredReady = defer()
    this.ready = deferredReady.promise
    this.#deferredReady = deferredReady
    this.demuxer.initialize().then(async () => {
      this.decoder = new AudioDecoder({
        output: this.bufferAudioData.bind(this),
        error: (e: any) => console.error(e),
      })

      const config = this.demuxer.getDecoderConfig()
      this.sampleRate = config.sampleRate
      this.channelCount = config.numberOfChannels

      debugLog(config)

      let support = await AudioDecoder.isConfigSupported(config)
      console.assert(support.supported)

      this.decoder.configure(config)

      // Initialize the ring buffer between the decoder and the real-time audio
      // rendering thread. The AudioRenderer has buffer space for approximately
      // 500ms of decoded audio ahead.
      let sampleCountIn500ms = DATA_BUFFER_DURATION * config.sampleRate * config.numberOfChannels
      this.ringbuffer = new RingBuffer(
        RingBuffer.getStorageForCapacity(sampleCountIn500ms, Float32Array),
        Float32Array,
      )

      this.#fillDataBuffer()
    })
  }

  play() {
    // resolves when audio has effectively started: this can take some time if using
    // bluetooth, for example.
    debugLog('playback start')
    this.playing = true
    this.#fillDataBuffer()
  }

  pause() {
    debugLog('playback stop')
    this.playing = false
  }

  bufferHealth() {
    return this.ringbuffer
      ? (1 - this.ringbuffer.available_write() / this.ringbuffer.capacity()) * 100
      : null
  }

  /**
   * From a array of Float32Array containing planar audio data `input`, writes
   * interleaved audio data to `output`. Start the copy at sample
   * `inputOffset`: index of the sample to start the copy from
   * `inputSamplesToCopy`: number of input samples to copy
   * `output`: a Float32Array to write the samples to
   * `outputSampleOffset`: an offset in `output` to start writing
   */
  interleave(
    inputs: Float32Array[],
    inputOffset: number,
    inputSamplesToCopy: number,
    output: Float32Array,
    outputSampleOffset: number,
  ) {
    if (inputs.length * inputs[0].length < output.length) {
      throw `not enough space in destination (${inputs.length * inputs[0].length} < ${
        output.length
      }})`
    }
    let channelCount = inputs.length
    let outIdx = outputSampleOffset
    let inputIdx = Math.floor(inputOffset / channelCount)
    var channel = inputOffset % channelCount
    for (var i = 0; i < inputSamplesToCopy; i++) {
      output[outIdx++] = inputs[channel][inputIdx]
      if (++channel == inputs.length) {
        channel = 0
        inputIdx++
      }
    }
  }

  bufferAudioData(data: {
    numberOfChannels: number
    numberOfFrames: number
    timestamp: any
    duration: number
    copyTo: (arg0: any, arg1: { planeIndex: number }) => void
  }) {
    if (!this.ringbuffer || !this.channelCount) return

    if (this.interleavingBuffers.length != data.numberOfChannels) {
      this.interleavingBuffers = new Array(this.channelCount)
      for (var i = 0; i < this.interleavingBuffers.length; i++) {
        this.interleavingBuffers[i] = new Float32Array(data.numberOfFrames)
      }
    }

    debugLog(`bufferAudioData() ts:${data.timestamp} durationSec:${data.duration / 1000000}`)
    // Write to temporary planar arrays, and interleave into the ring buffer.
    for (var i = 0; i < this.channelCount; i++) {
      data.copyTo(this.interleavingBuffers[i], { planeIndex: i })
    }
    // Write the data to the ring buffer. Because it wraps around, there is
    // potentially two copyTo to do.
    let wrote = this.ringbuffer.writeCallback(
      data.numberOfFrames * data.numberOfChannels,
      (first_part: string | any[], second_part: string | any[]) => {
        this.interleave(this.interleavingBuffers, 0, first_part.length, first_part, 0)
        this.interleave(
          this.interleavingBuffers,
          first_part.length,
          second_part.length,
          second_part,
          0,
        )
      },
    )

    // FIXME - this could theoretically happen since we're pretty agressive
    // about saturating the decoder without knowing the size of the
    // AudioData.duration vs ring buffer capacity.
    console.assert(
      wrote == data.numberOfChannels * data.numberOfFrames,
      'Buffer full, dropping data!',
    )

    // Logging maxBufferHealth below shows we currently max around 73%, so we're
    // safe from the assert above *for now*. We should add an overflow buffer
    // just to be safe.
    // let bufferHealth = this.bufferHealth();
    // if (!('maxBufferHealth' in this))
    //   this.maxBufferHealth = 0;
    // if (bufferHealth > this.maxBufferHealth) {
    //   this.maxBufferHealth = bufferHealth;
    //   console.log(`new maxBufferHealth:${this.maxBufferHealth}`);
    // }

    // fillDataBuffer() gives up if too much decode work is queued. Keep trying
    // now that we've finished some.
    this.#fillDataBuffer()
  }

  async #fillDataBuffer() {
    // This method is called from multiple places to ensure the buffer stays
    // healthy. Sometimes these calls may overlap, but at any given point only
    // one call is desired.
    if (this.fillInProgress) return

    this.fillInProgress = true
    // This should be this file's ONLY call to the *Internal() variant of this method.
    await this.#fillDataBufferInternal()
    this.fillInProgress = false
  }

  async #fillDataBufferInternal() {
    if (!this.decoder || !this.ringbuffer || !this.channelCount || !this.sampleRate) return

    debugLog(`fillDataBufferInternal()`)

    if (this.decoder.decodeQueueSize >= DECODER_QUEUE_SIZE_MAX) {
      debugLog('\tdecoder saturated')
      // Some audio decoders are known to delay output until the next input.
      // Make sure the DECODER_QUEUE_SIZE is big enough to avoid stalling on the
      // return below. We're relying on decoder output callback to trigger
      // another call to fillDataBuffer().
      console.assert(DECODER_QUEUE_SIZE_MAX >= 2)
      return
    }

    let usedBufferElements = this.ringbuffer.capacity() - this.ringbuffer.available_write()
    let usedBufferSecs = usedBufferElements / (this.channelCount * this.sampleRate)
    let pcntOfTarget = (100 * usedBufferSecs) / DATA_BUFFER_DECODE_TARGET_DURATION
    if (usedBufferSecs >= DATA_BUFFER_DECODE_TARGET_DURATION) {
      debugLog(
        `\taudio buffer full usedBufferSecs: ${usedBufferSecs} pcntOfTarget: ${pcntOfTarget}`,
      )

      // When playing, schedule timeout to periodically refill buffer. Don't
      // bother scheduling timeout if decoder already saturated. The output
      // callback will call us back to keep filling.
      if (this.playing)
        // Timeout to arrive when buffer is half empty.
        setTimeout(this.#fillDataBuffer.bind(this), (1000 * usedBufferSecs) / 2)

      // Initialize() is done when the buffer fills for the first time.
      if (!this.#deferredReady.resolved) {
        this.#deferredReady.resolve()
      }

      // Buffer full, so no further work to do now.
      return
    }

    // Decode up to the buffering target or until decoder is saturated.
    while (
      usedBufferSecs < DATA_BUFFER_DECODE_TARGET_DURATION &&
      this.decoder.decodeQueueSize < DECODER_QUEUE_SIZE_MAX
    ) {
      debugLog(
        `\tMore samples. usedBufferSecs:${usedBufferSecs} < target:${DATA_BUFFER_DECODE_TARGET_DURATION}.`,
      )
      let chunk = await this.demuxer.getNextChunk()
      this.decoder.decode(chunk)

      // NOTE: awaiting the demuxer.readSample() above will also give the
      // decoder output callbacks a chance to run, so we may see usedBufferSecs
      // increase.
      usedBufferElements = this.ringbuffer.capacity() - this.ringbuffer.available_write()
      usedBufferSecs = usedBufferElements / (this.channelCount * this.sampleRate)
    }

    if (ENABLE_DEBUG_LOGGING) {
      let logPrefix =
        usedBufferSecs >= DATA_BUFFER_DECODE_TARGET_DURATION
          ? '\tbuffered enough'
          : '\tdecoder saturated'
      pcntOfTarget = (100 * usedBufferSecs) / DATA_BUFFER_DECODE_TARGET_DURATION
      debugLog(logPrefix + `; bufferedSecs:${usedBufferSecs} pcntOfTarget: ${pcntOfTarget}`)
    }
  }
}
