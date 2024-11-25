import MP4Box from 'mp4box'
import { debugLog } from '../lib/debug-log.ts'
import { Defer, defer } from '../lib/defer.ts'

export class MP4Source {
  info = null

  file: any
  #deferredInfo: Defer<unknown>

  constructor(uri: RequestInfo | URL) {
    this.file = MP4Box.createFile()
    this.file.onError = console.error.bind(console)
    this.file.onReady = info => {
      // TODO: Generate configuration changes.
      this.info = info
      this.#deferredInfo.resolve(info)
    }
    this.#deferredInfo = defer()
    this.#initialize(uri)
  }

  async #initialize(uri: RequestInfo | URL) {
    debugLog('fetching file')

    const response = await fetch(uri)

    debugLog('fetch responded')

    const reader = response.body!.getReader()
    let offset = 0
    let mp4File = this.file

    function appendBuffers({
      done,
      value,
    }: ReadableStreamReadResult<Uint8Array>): Promise<void> | void {
      if (done) {
        mp4File.flush()
        return
      }
      let buf = value.buffer
      buf.fileStart = offset

      offset += buf.byteLength

      mp4File.appendBuffer(buf)

      return reader.read().then(appendBuffers)
    }

    return reader.read().then(appendBuffers)
  }

  async getInfo() {
    if (this.info) return this.info
    return this.#deferredInfo.promise
  }

  getDescriptionBox() {
    // TODO: make sure this is coming from the right track.
    const entry = this.file.moov.traks[0].mdia.minf.stbl.stsd.entries[0]
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C
    if (!box) {
      throw new Error('avcC, hvcC, vpcC, or av1C box not found!')
    }
    return box
  }

  getAudioSpecificConfig() {
    // TODO: make sure this is coming from the right track.

    // 0x04 is the DecoderConfigDescrTag. Assuming MP4Box always puts this at position 0.
    console.assert(
      this.file.moov.traks[0].mdia.minf.stbl.stsd.entries[0].esds.esd.descs[0].tag == 0x04,
    )
    // 0x40 is the Audio OTI, per table 5 of ISO 14496-1
    console.assert(
      this.file.moov.traks[0].mdia.minf.stbl.stsd.entries[0].esds.esd.descs[0].oti == 0x40,
    )
    // 0x05 is the DecSpecificInfoTag
    console.assert(
      this.file.moov.traks[0].mdia.minf.stbl.stsd.entries[0].esds.esd.descs[0].descs[0].tag == 0x05,
    )

    return this.file.moov.traks[0].mdia.minf.stbl.stsd.entries[0].esds.esd.descs[0].descs[0].data
  }

  selectTrack(track: { id: any }) {
    debugLog('selecting track %d', track.id)
    this.file.setExtractionOptions(track.id)
  }

  start(callback: any) {
    this.file.onSamples = (track_id: any, ref: any, samples: any) => callback(samples)
    this.file.start()
  }

  stop() {
    this.file.stop()
  }
}
