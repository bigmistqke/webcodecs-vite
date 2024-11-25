import MP4Box from 'mp4box'
import { debugLog } from '../lib/debug-log.ts'
import { Defer, defer } from '../lib/defer.ts'
import { MP4Source } from './mp4-source.ts'

function chunkInitFromSample(sample: unknown): EncodedVideoChunkInit {
  return {
    type: sample.is_sync ? 'key' : 'delta',
    timestamp: (sample.cts * 1000000) / sample.timescale,
    duration: (sample.duration * 1000000) / sample.timescale,
    data: sample.data,
  } as const
}

// Wrapper around MP4Box.js that shims pull-based demuxing on top their push-based API.
class MP4PullDemuxer {
  readySamples: Array<unknown> = []

  #deferredSample: Defer<unknown>
  fileUri: any
  selectedTrack?: any
  source: MP4Source
  track: unknown

  constructor(fileUri: any) {
    this.fileUri = fileUri
    this.#deferredSample = defer()
    this.source = new MP4Source(this.fileUri)
  }

  _getDescription(descriptionBox: { write: (arg0: any) => void }) {
    const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN)
    descriptionBox.write(stream)
    return new Uint8Array(stream.buffer, 8) // Remove the box header.
  }

  _selectTrack(track: any) {
    console.assert(!this.selectedTrack, 'changing tracks is not implemented')
    this.selectedTrack = track
    this.source.selectTrack(track)
  }

  async _readSample() {
    console.assert(this.selectedTrack)

    if (this.readySamples.length > 0) {
      return Promise.resolve(this.readySamples.shift())
    }

    this.source.start(this._onSamples.bind(this))

    return this.#deferredSample.promise
  }

  _onSamples(samples: unknown[]) {
    const SAMPLE_BUFFER_TARGET_SIZE = 50

    this.readySamples.push(...samples)
    if (this.readySamples.length >= SAMPLE_BUFFER_TARGET_SIZE) {
      this.source.stop()
    }

    let firstSampleTime = (samples[0].cts * 1000000) / samples[0].timescale
    debugLog(
      `adding new ${samples.length} samples (first = ${firstSampleTime}). total = ${this.readySamples.length}`,
    )

    if (!this.#deferredSample.resolved) {
      this.#deferredSample.resolve(this.readySamples.shift())
    }
  }
}

export class MP4PullVideoDemuxer extends MP4PullDemuxer {
  async initialize() {
    let info = await this.source!.getInfo()
    this.track = info.videoTracks[0]
    this._selectTrack(this.track)
  }

  getDecoderConfig() {
    return {
      // Browser doesn't support parsing full vp8 codec (eg: `vp08.00.41.08`),
      // they only support `vp8`.
      codec: this.track.codec.startsWith('vp08') ? 'vp8' : this.track.codec,
      displayWidth: this.track.track_width,
      displayHeight: this.track.track_height,
      description: this._getDescription(this.source.getDescriptionBox()),
    }
  }

  async getNextChunk() {
    const sample = await this._readSample()
    return new EncodedVideoChunk(chunkInitFromSample(sample))
  }
}

export class MP4PullAudioDemuxer extends MP4PullDemuxer {
  async initialize() {
    const info = await this.source!.getInfo()
    this.track = info.audioTracks[0]
    this._selectTrack(this.track)
  }

  getDecoderConfig() {
    return {
      codec: this.track.codec,
      sampleRate: this.track.audio.sample_rate,
      numberOfChannels: this.track.audio.channel_count,
      description: this.source.getAudioSpecificConfig(),
    }
  }

  async getNextChunk() {
    const sample = await this._readSample()
    return new EncodedAudioChunk(chunkInitFromSample(sample))
  }
}
