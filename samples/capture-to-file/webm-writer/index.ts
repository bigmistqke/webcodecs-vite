import { ArrayBufferDataStream } from './ArrayBufferDataStream.ts'
import { BlobBuffer } from './BlobBuffer.ts'

type RequireKeys<TObject extends object, TKeys extends keyof TObject> = Required<
  Pick<TObject, TKeys>
> &
  Omit<TObject, TKeys>

// Just a little utility so we can tag values as floats for the EBML encoder's benefit
class EBMLFloat32 {
  constructor(public value: number) {}
}

class EBMLFloat64 {
  constructor(public value: number) {}
}

/**
 * WebM video encoder for Google Chrome. This implementation is suitable for
 * creating very large video files, because it can stream Blobs directly to a
 * FileWriter without buffering the entire video in memory.
 *
 * When FileWriter is not available or not desired, it can buffer the video in
 * memory as a series of Blobs which are eventually returned as one composite
 * Blob.
 *
 * By Nicholas Sherlock.
 *
 * Based on the ideas from Whammy: https://github.com/antimatter15/whammy
 *
 * Released under the WTFPLv2 https://en.wikipedia.org/wiki/WTFPL
 */

interface Frame {
  /** Raw VP8 frame data */
  // frame: string
  frame: Uint8Array
  /** From 1 to 126 (inclusive) */
  trackNumber?: number
  timecode?: number
  intime: any
  type?: any
}

interface Cluster {
  /** Start time for the cluster */
  timecode: number
}

interface Cue {
  id: number // Cue
  data: Array<{
    id: number // CueTime
    data: any
  }>
}

export interface EBMLObject {
  data: EBML | Array<EBML>
  id: number
  size?: number
  offset?: number
  dataOffset?: number
}

export type EBML = string | number | Uint8Array | EBMLFloat32 | EBMLFloat64 | EBMLObject

interface WebMWriterOptions {
  /** Chrome FileWriter in order to stream to a file instead of buffering to memory (optional) */
  fileWriter?: any
  /** Node.JS file descriptor to write to instead of buffering (optional) */
  fileDescriptor?: number | null
  /** Codec to write to webm file */
  codec?: any
  width?: number
  height?: number
}

/**
 * @param ArrayBufferDataStream - Imported library
 * @param BlobBuffer - Imported library
 *
 * @returns WebMWriter
 *
 * @constructor
 */
class WebMWriter {
  MAX_CLUSTER_DURATION_MSEC = 5000
  DEFAULT_TRACK_NUMBER = 1
  writtenHeader = false
  videoWidth = 0
  videoHeight = 0
  firstTimestampEver = true
  earliestTimestamp = 0
  clusterFrameBuffer: Array<RequireKeys<Frame, 'timecode' | 'trackNumber'>> = []
  clusterStartTime = 0
  clusterDuration = 0
  lastTimeCode = 0
  seekPoints = {
    Cues: {
      id: new Uint8Array([0x1c, 0x53, 0xbb, 0x6b]),
      positionEBML: null as null | EBMLObject,
    },
    SegmentInfo: {
      id: new Uint8Array([0x15, 0x49, 0xa9, 0x66]),
      positionEBML: null as null | EBMLObject,
    },
    Tracks: {
      id: new Uint8Array([0x16, 0x54, 0xae, 0x6b]),
      positionEBML: null as null | EBMLObject,
    },
  }
  segmentDuration: EBMLObject = {
    id: 0x4489, // Duration
    data: new EBMLFloat64(0),
  }
  cues: Array<Cue> = []
  blobBuffer: BlobBuffer
  options: WebMWriterOptions

  ebmlSegment?: EBMLObject // Root element of the EBML document
  seekHead?: EBMLObject

  constructor(options: WebMWriterOptions) {
    this.options = {
      fileWriter: null,
      fileDescriptor: null,
      codec: 'VP8',
      ...options,
    }
    this.blobBuffer = new BlobBuffer(options.fileWriter || options.fileDescriptor)
  }

  addFrame(frame) {
    if (!this.writtenHeader) {
      this.videoWidth = this.options.width
      this.videoHeight = this.options.height
      this.#writeHeader()
    }
    if (frame.constructor.name == 'EncodedVideoChunk') {
      let frameData = new Uint8Array(frame.byteLength)
      frame.copyTo(frameData)
      this.#addFrameToCluster({
        frame: frameData,
        intime: frame.timestamp,
        type: frame.type,
      })
      return
    }
  }

  /**
   * Add an encoded video chunk to the video.
   *
   * @param {EncodedVideoChunk} chunk
   *
   */
  addChunk(chunk: EncodedVideoChunk) {
    if (!this.writtenHeader) {
      this.videoWidth = this.options.width
      this.videoHeight = this.options.height
      this.#writeHeader()
    }

    const frameData = new Uint8Array(chunk.byteLength)
    chunk.copyTo(frameData)

    this.#addFrameToCluster({
      frame: frameData,
      intime: chunk.timestamp,
      type: chunk.type,
    })

    return
  }

  /**
   * Finish writing the video and return a Promise to signal completion.
   *
   * If the destination device was memory (i.e. options.fileWriter was not
   * supplied), the Promise is resolved with a Blob with the contents of the
   * entire video.
   */
  complete() {
    if (!this.writtenHeader) {
      this.#writeHeader()
    }
    this.firstTimestampEver = true

    this.#flushClusterFrameBuffer()

    this.#writeCues()
    this.#rewriteSeekHead()
    this.#rewriteDuration()

    return this.blobBuffer.complete('video/webm')
  }

  getWrittenSize() {
    return this.blobBuffer.length
  }

  /**********************************************************************************/
  /*                                                                                */
  /*                                   Internals                                    */
  /*                                                                                */
  /**********************************************************************************/

  #fileOffsetToSegmentRelative(fileOffset: number) {
    return fileOffset - this.ebmlSegment!.dataOffset!
  }

  /**
   * Create a SeekHead element with descriptors for the points in the global
   * seekPoints array.
   *
   * 5 bytes of position values are reserved for each node, which lie at the
   * offset point.positionEBML.dataOffset, to be overwritten later.
   */
  #createSeekHead() {
    const seekPositionEBMLTemplate = {
      id: 0x53ac, // SeekPosition
      size: 5, // Allows for 32GB video files
      data: 0, // We'll overwrite this when the file is complete
    }

    const result = {
      id: 0x114d9b74, // SeekHead
      data: [] as Array<EBML>,
    }

    for (let name in this.seekPoints) {
      const seekPoint = this.seekPoints[name as keyof typeof this.seekPoints]
      seekPoint.positionEBML = Object.create(seekPositionEBMLTemplate)
      result.data.push({
        id: 0x4dbb, // Seek
        data: [
          {
            id: 0x53ab, // SeekID
            data: seekPoint.id,
          },
          seekPoint.positionEBML!,
        ],
      })
    }

    return result
  }

  #createHeader() {
    const ebmlHeader = {
      id: 0x1a45dfa3, // EBML
      data: [
        {
          id: 0x4286, // EBMLVersion
          data: 1,
        },
        {
          id: 0x42f7, // EBMLReadVersion
          data: 1,
        },
        {
          id: 0x42f2, // EBMLMaxIDLength
          data: 4,
        },
        {
          id: 0x42f3, // EBMLMaxSizeLength
          data: 8,
        },
        {
          id: 0x4282, // DocType
          data: 'webm',
        },
        {
          id: 0x4287, // DocTypeVersion
          data: 2,
        },
        {
          id: 0x4285, // DocTypeReadVersion
          data: 2,
        },
      ],
    }
    const segmentInfo = {
      id: 0x1549a966, // Info
      data: [
        {
          id: 0x2ad7b1, // TimecodeScale
          data: 1e6, // Times will be in microseconds (1e6 nanoseconds
          // per step = 1ms)
        },
        {
          id: 0x4d80, // MuxingApp
          data: 'webm-writer-js',
        },
        {
          id: 0x5741, // WritingApp
          data: 'webm-writer-js',
        },
        this.segmentDuration, // To be filled in later
      ],
    }
    const tracks = {
      id: 0x1654ae6b, // Tracks
      data: [
        {
          id: 0xae, // TrackEntry
          data: [
            {
              id: 0xd7, // TrackNumber
              data: this.DEFAULT_TRACK_NUMBER,
            },
            {
              id: 0x73c5, // TrackUID
              data: this.DEFAULT_TRACK_NUMBER,
            },
            {
              id: 0x83, // TrackType
              data: 1,
            },
            {
              id: 0xe0, // Video
              data: [
                {
                  id: 0xb0, // PixelWidth
                  data: this.videoWidth,
                },
                {
                  id: 0xba, // PixelHeight
                  data: this.videoHeight,
                },
              ],
            },
            {
              id: 0x9c, // FlagLacing
              data: 0,
            },
            {
              id: 0x22b59c, // Language
              data: 'und',
            },
            {
              id: 0xb9, // FlagEnabled
              data: 1,
            },
            {
              id: 0x88, // FlagDefault
              data: 1,
            },
            {
              id: 0x55aa, // FlagForced
              data: 0,
            },

            {
              id: 0x86, // CodecID
              data: 'V_' + this.options.codec,
            } /*
       (options.codec == 'VP8' ?
            {
              'id': 0x63A2,  // Codec private data
              'data': []
            } :
            {
              'id': 0x63A2,  // Codec private data for vp9
              'data': [
                {
                  'id': 1,  // vp9 Profile
                  'size': 1,
                  'data': 0
                },
                {
                  'id': 2,  // Feature level
                  'size': 1,
                  'data': 10
                },
                {
                  'id': 3,  // bitdepth level
                  'size': 1,
                  'data': 8
                },
                {
                  'id': 4,  // color sampling
                  'size': 1,
                  'data': 0
                }
              ]
            }),
       {
         'id': 0x258688,  // CodecName
         'data': options.codec
       },*/,
          ],
        },
      ],
    }
    return {
      ebmlHeader,
      segmentInfo,
      tracks,
    }
  }

  /**
   * Write the WebM file header to the stream.
   */
  #writeHeader() {
    this.seekHead = this.#createSeekHead()

    const { segmentInfo, tracks, ebmlHeader } = this.#createHeader()

    this.ebmlSegment = {
      id: 0x18538067, // Segment
      size: -1, // Unbounded size
      data: [this.seekHead, segmentInfo, tracks],
    }

    let bufferStream = new ArrayBufferDataStream(256)

    this.#writeEBML(bufferStream, this.blobBuffer.pos, [ebmlHeader, this.ebmlSegment!])
    this.blobBuffer.write(bufferStream.getAsDataArray())

    // Now we know where these top-level elements lie in the file:
    this.seekPoints.SegmentInfo.positionEBML!.data = this.#fileOffsetToSegmentRelative(
      // @ts-expect-error   FIXME: writeEBML mutates segmentInfo
      segmentInfo.offset,
    )
    this.seekPoints.Tracks.positionEBML!.data = this.#fileOffsetToSegmentRelative(
      // @ts-expect-error   FIXME: writeEBML mutates tracks
      tracks.offset,
    )

    this.writtenHeader = true
  }

  /**
   * Create a SimpleBlock element to hold the given frame.
   *
   * @param {Frame} frame
   *
   * @return A SimpleBlock EBML element.
   */
  #createSimpleBlockForframe(frame: RequireKeys<Frame, 'trackNumber' | 'timecode'>) {
    let bufferStream = new ArrayBufferDataStream(1 + 2 + 1)

    if (!(frame.trackNumber > 0 && frame.trackNumber < 127)) {
      throw new Error('TrackNumber must be > 0 and < 127')
    }

    bufferStream.writeEBMLVarInt(frame.trackNumber) // Always 1 byte since we limit the range of
    // trackNumber
    bufferStream.writeU16BE(frame.timecode)

    // Flags byte
    bufferStream.writeByte(
      (frame.type == 'key' ? 1 : 0) << 7, // frame
    )

    return {
      id: 0xa3, // SimpleBlock
      data: [bufferStream.getAsDataArray(), frame.frame],
    }
  }

  /**
   * Create a Cluster EBML node.
   *
   * @param {Cluster} cluster
   *
   * Returns an EBMLObject.
   */
  #createCluster(cluster: Cluster) {
    return {
      id: 0x1f43b675,
      data: [
        {
          id: 0xe7, // Timecode
          data: Math.round(cluster.timecode),
        },
      ] as Array<EBML>,
    }
  }

  #addCuePoint(trackIndex: number, clusterTime: number, clusterFileOffset: any) {
    this.cues.push({
      id: 0xbb, // Cue
      data: [
        {
          id: 0xb3, // CueTime
          data: clusterTime,
        },
        {
          id: 0xb7, // CueTrackPositions
          data: [
            {
              id: 0xf7, // CueTrack
              data: trackIndex,
            },
            {
              id: 0xf1, // CueClusterPosition
              data: this.#fileOffsetToSegmentRelative(clusterFileOffset),
            },
          ],
        },
      ],
    })
  }

  /**
   * Write a Cues element to the blobStream using the global `cues` array of
   * CuePoints (use addCuePoint()). The seek entry for the Cues in the
   * SeekHead is updated.
   */
  firstCueWritten = false
  #writeCues() {
    if (this.firstCueWritten) return
    this.firstCueWritten = true

    const cuesEbml = { id: 0x1c53bb6b, data: this.cues }
    const cuesBuffer = new ArrayBufferDataStream(16 + this.cues.length * 32) // Pretty crude estimate of the buffer size we'll need

    this.#writeEBML(cuesBuffer, this.blobBuffer.pos, cuesEbml)
    this.blobBuffer.write(cuesBuffer.getAsDataArray())

    // Now we know where the Cues element has ended up, we can update the SeekHead
    this.seekPoints.Cues.positionEBML!.data = this.#fileOffsetToSegmentRelative(
      // @ts-expect-error   FIXME: writeEBML mutates ebml
      cuesEbml.offset,
    )
  }

  /**
   * Flush the frames in the current clusterFrameBuffer out to the stream as a Cluster.
   */
  #flushClusterFrameBuffer() {
    if (this.clusterFrameBuffer.length === 0) {
      return
    }

    // First work out how large of a buffer we need to hold the cluster data
    let rawImageSize = 0

    for (let i = 0; i < this.clusterFrameBuffer.length; i++) {
      rawImageSize += this.clusterFrameBuffer[i].frame.byteLength
    }

    let buffer = new ArrayBufferDataStream(rawImageSize + this.clusterFrameBuffer.length * 64) // Estimate 64 bytes per block header
    let cluster = this.#createCluster({
      timecode: Math.round(this.clusterStartTime),
    })

    for (let i = 0; i < this.clusterFrameBuffer.length; i++) {
      cluster.data.push(this.#createSimpleBlockForframe(this.clusterFrameBuffer[i]))
    }

    this.#writeEBML(buffer, this.blobBuffer.pos, cluster)
    this.blobBuffer.write(buffer.getAsDataArray())

    this.#addCuePoint(this.DEFAULT_TRACK_NUMBER, Math.round(this.clusterStartTime), cluster.offset)

    this.clusterFrameBuffer = []
    this.clusterDuration = 0
  }

  #addFrameToCluster(frame: Frame) {
    let time = frame.intime / 1000
    if (this.firstTimestampEver) {
      this.earliestTimestamp = time
      time = 0
      this.firstTimestampEver = false
    } else {
      time = time - this.earliestTimestamp
    }
    this.lastTimeCode = time
    if (this.clusterDuration == 0) this.clusterStartTime = time

    const clusterFrame = {
      ...frame,
      trackNumber: this.DEFAULT_TRACK_NUMBER,
      // Frame timecodes are relative to the start of their cluster:
      timecode: Math.round(time - this.clusterStartTime),
    }

    this.clusterFrameBuffer.push(clusterFrame)
    this.clusterDuration = clusterFrame.timecode + 1

    if (this.clusterDuration >= this.MAX_CLUSTER_DURATION_MSEC) {
      this.#flushClusterFrameBuffer()
    }
  }

  /**
   * Rewrites the SeekHead element that was initially written to the stream
   * with the offsets of top level elements.
   *
   * Call once writing is complete (so the offset of all top level elements
   * is known).
   */
  #rewriteSeekHead() {
    const seekHeadBuffer = new ArrayBufferDataStream(this.seekHead!.size!)
    const oldPos = this.blobBuffer.pos

    // Write the rewritten SeekHead element's data payload to the stream
    // (don't need to update the id or size)
    this.#writeEBML(seekHeadBuffer, this.seekHead!.dataOffset, this.seekHead!.data)

    // And write that through to the file
    this.blobBuffer.seek(this.seekHead!.dataOffset!)
    this.blobBuffer.write(seekHeadBuffer.getAsDataArray())
    this.blobBuffer.seek(oldPos)
  }

  /**
   * Rewrite the Duration field of the Segment with the newly-discovered
   * video duration.
   */
  #rewriteDuration() {
    const buffer = new ArrayBufferDataStream(8)
    const oldPos = this.blobBuffer.pos

    // Rewrite the data payload (don't need to update the id or size)
    buffer.writeDoubleBE(this.lastTimeCode)

    // And write that through to the file
    this.blobBuffer.seek(this.segmentDuration.dataOffset!)
    this.blobBuffer.write(buffer.getAsDataArray())

    this.blobBuffer.seek(oldPos)
  }

  #writeEBML(
    buffer: ArrayBufferDataStream,
    bufferFileOffset: any,
    ebml: Exclude<EBML, number> | Array<Exclude<EBML, number>>,
  ) {
    // Is the ebml an array of sibling elements?
    if (Array.isArray(ebml)) {
      for (let i = 0; i < ebml.length; i++) {
        this.#writeEBML(buffer, bufferFileOffset, ebml[i])
      }
      // Is this some sort of raw data that we want to write directly?
    } else if (typeof ebml === 'string') {
      buffer.writeString(ebml)
    } else if (ebml instanceof Uint8Array) {
      buffer.writeBytes(ebml)
    } else if ('id' in ebml) {
      // We're writing an EBML element
      ebml.offset = buffer.pos + bufferFileOffset

      buffer.writeUnsignedIntBE(ebml.id) // ID field

      // Now we need to write the size field, so we must know the payload size:

      if (Array.isArray(ebml.data)) {
        // Writing an array of child elements. We won't try to measure the size of
        // the children up-front

        let sizePos, dataBegin, dataEnd

        if (ebml.size === -1) {
          // Write the reserved all-one-bits marker to note that the size of this
          // element is unknown/unbounded
          buffer.writeByte(0xff)
        } else {
          sizePos = buffer.pos

          /* Write a dummy size field to overwrite later. 4 bytes allows an
           * element maximum size of 256MB, which should be plenty (we don't want
           * to have to buffer that much data in memory at one time anyway!)
           */
          buffer.writeBytes([0, 0, 0, 0])
        }

        dataBegin = buffer.pos

        ebml.dataOffset = dataBegin + bufferFileOffset
        this.#writeEBML(buffer, bufferFileOffset, ebml.data)

        if (ebml.size !== -1) {
          dataEnd = buffer.pos

          ebml.size = dataEnd - dataBegin

          buffer.seek(sizePos)
          buffer.writeEBMLVarIntWidth(ebml.size, 4) // Size field

          buffer.seek(dataEnd)
        }
      } else if (typeof ebml.data === 'string') {
        buffer.writeEBMLVarInt(ebml.data.length) // Size field
        ebml.dataOffset = buffer.pos + bufferFileOffset
        buffer.writeString(ebml.data)
      } else if (typeof ebml.data === 'number') {
        // Allow the caller to explicitly choose the size if they wish by
        // supplying a size field
        if (!ebml.size) {
          ebml.size = buffer.measureUnsignedInt(ebml.data)
        }

        buffer.writeEBMLVarInt(ebml.size) // Size field
        ebml.dataOffset = buffer.pos + bufferFileOffset
        buffer.writeUnsignedIntBE(ebml.data, ebml.size)
      } else if (ebml.data instanceof EBMLFloat64) {
        buffer.writeEBMLVarInt(8) // Size field
        ebml.dataOffset = buffer.pos + bufferFileOffset
        buffer.writeDoubleBE(ebml.data.value)
      } else if (ebml.data instanceof EBMLFloat32) {
        buffer.writeEBMLVarInt(4) // Size field
        ebml.dataOffset = buffer.pos + bufferFileOffset
        buffer.writeFloatBE(ebml.data.value)
      } else if (ebml.data instanceof Uint8Array) {
        buffer.writeEBMLVarInt(ebml.data.byteLength) // Size field
        ebml.dataOffset = buffer.pos + bufferFileOffset
        buffer.writeBytes(ebml.data)
      } else {
        throw new Error('Bad EBML datatype ' + typeof ebml.data)
      }
    } else {
      throw new Error('Bad EBML datatype ' + typeof ebml.data)
    }
  }
}

export { ArrayBufferDataStream, BlobBuffer, WebMWriter }
