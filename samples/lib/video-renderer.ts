import { MP4PullVideoDemuxer } from '../audio-video-player/mp4-pull-demuxer.ts'
import { debugLog } from './debug-log.ts'
import { defer, Defer } from './defer.ts'

const FRAME_BUFFER_TARGET_SIZE = 3
const ENABLE_DEBUG_LOGGING = false

// Controls demuxing and decoding of the video track, as well as rendering
// VideoFrames to canvas. Maintains a buffer of FRAME_BUFFER_TARGET_SIZE
// decoded frames for future rendering.
export class VideoRenderer {
  frameBuffer: Array<VideoFrame> = []
  fillInProgress = false
  ready: Promise<void>
  #deferredReady: Defer<void>
  canvasCtx: OffscreenCanvasRenderingContext2D

  decoder?: VideoDecoder
  init_resolver?: null

  constructor(public demuxer: MP4PullVideoDemuxer, public canvas: OffscreenCanvas) {
    this.#initialize()
    this.#deferredReady = defer()
    this.ready = this.#deferredReady.promise
    this.canvasCtx = this.canvas.getContext('2d')!
  }

  async #initialize() {
    await this.demuxer.initialize()
    const config = this.demuxer.getDecoderConfig()

    this.canvas.width = config.displayWidth
    this.canvas.height = config.displayHeight

    this.decoder = new VideoDecoder({
      output: this.bufferFrame.bind(this),
      error: e => console.error(e),
    })

    let support = await VideoDecoder.isConfigSupported(config)
    console.assert(support.supported)
    this.decoder.configure(config)

    this.fillFrameBuffer()
  }

  render(timestamp: number) {
    debugLog('render(%d)', timestamp)
    let frame = this.chooseFrame(timestamp)
    this.fillFrameBuffer()

    if (frame == null) {
      console.warn('VideoRenderer.render(): no frame ')
      return
    }

    this.paint(frame)
  }

  chooseFrame(timestamp: number) {
    if (this.frameBuffer.length == 0) return null

    let minTimeDelta = Number.MAX_VALUE
    let frameIndex = -1

    for (let i = 0; i < this.frameBuffer.length; i++) {
      let time_delta = Math.abs(timestamp - this.frameBuffer[i].timestamp)
      if (time_delta < minTimeDelta) {
        minTimeDelta = time_delta
        frameIndex = i
      } else {
        break
      }
    }

    console.assert(frameIndex != -1)

    if (frameIndex > 0) debugLog('dropping %d stale frames', frameIndex)

    for (let i = 0; i < frameIndex; i++) {
      let staleFrame = this.frameBuffer.shift()
      staleFrame.close()
    }

    let chosenFrame = this.frameBuffer[0]
    debugLog(
      'frame time delta = %dms (%d vs %d)',
      minTimeDelta / 1000,
      timestamp,
      chosenFrame.timestamp,
    )
    return chosenFrame
  }

  async fillFrameBuffer() {
    if (this.frameBufferFull()) {
      debugLog('frame buffer full')

      if (!this.#deferredReady.resolved) {
        this.#deferredReady.resolve()
      }

      return
    }

    // This method can be called from multiple places and we some may already
    // be awaiting a demuxer read (only one read allowed at a time).
    if (this.fillInProgress) {
      return false
    }
    this.fillInProgress = true

    while (
      this.frameBuffer.length < FRAME_BUFFER_TARGET_SIZE &&
      this.decoder &&
      this.decoder.decodeQueueSize < FRAME_BUFFER_TARGET_SIZE
    ) {
      let chunk = await this.demuxer.getNextChunk()
      this.decoder.decode(chunk)
    }

    this.fillInProgress = false

    // Give decoder a chance to work, see if we saturated the pipeline.
    setTimeout(this.fillFrameBuffer.bind(this), 0)
  }

  frameBufferFull() {
    return this.frameBuffer.length >= FRAME_BUFFER_TARGET_SIZE
  }

  bufferFrame(frame: VideoFrame) {
    debugLog(`bufferFrame(${frame.timestamp})`)
    this.frameBuffer.push(frame)
  }

  paint(frame: VideoFrame) {
    this.canvasCtx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height)
  }
}
