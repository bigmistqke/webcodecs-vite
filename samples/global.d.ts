declare global {
  type EncodedAudioChunkType = 'key' | 'delta'

  class EncodedAudioChunk {
    constructor(config: EncodedVideoChunkInit) {}
    type: EncodedAudioChunkType
    timestamp: number
    duration?: number
    byteLength: number

    copyTo(destination: ArrayBuffer): void
  }

  type AudioSampleFormat = 'f32' | 's16'

  interface AudioDecoderConfig {
    codec: string // e.g., 'opus', 'aac'
    sampleRate: number // in Hz
    numberOfChannels: number // 1 for mono, 2 for stereo, etc.
    description?: ArrayBuffer // Codec-specific configuration
  }

  interface AudioData {
    format: AudioSampleFormat
    sampleRate: number
    numberOfFrames: number
    numberOfChannels: number
    timestamp: number
    duration: number

    copyTo(destination: Float32Array | Int16Array): void
    close(): void
  }

  type AudioDecoderState = 'unconfigured' | 'configured' | 'closed'

  interface AudioDecoderInit {
    output: (data: AudioData) => void
    error: (error: DOMException) => void
  }

  interface AudioDecoderSupport {
    supported: boolean
    config: AudioDecoderConfig
  }

  class AudioDecoder {
    static isConfigSupported(config: AudioDecoderConfig): Promise<AudioDecoderSupport>

    decodeQueueSize: number
    state: AudioDecoderState

    constructor(init: AudioDecoderInit)

    configure(config: AudioDecoderConfig): void
    decode(chunk: EncodedAudioChunk): void
    flush(): Promise<void>
    close(): void
    reset(): void
  }

  interface ImageDecoderConfig {
    type: string // MIME type of the image, e.g., 'image/jpeg', 'image/png'
    data?: BufferSource // Optional data for the image decoder
  }

  interface ImageDecodeOptions {
    frameIndex?: number // Index of the frame to decode, for animated images
  }

  interface ImageDecodeResult {
    image: VideoFrame // The decoded image
    complete: boolean // Whether the entire image was decoded
  }

  interface ImageTrack {
    frameCount
    repetitionCount
    animated
    selected
  }

  declare class ImageDecoder {
    completed: Promise<boolean>
    complete: boolean
    tracks: Array<ImageTrack> & {
      ready: Promise<void>
      selectedTrack: ImageTrack
    }

    constructor(init: ImageDecoderConfig)

    static isConfigSupported(config: ImageDecoderConfig): Promise<{ supported: boolean }>

    readonly type: string // The MIME type of the image
    readonly track: ImageTrack // Information about the image track
    readonly state: 'unconfigured' | 'configured' | 'closed' // Decoder state

    configure(config: ImageDecoderConfig): void
    decode(options?: ImageDecodeOptions): Promise<ImageDecodeResult>
    reset(): void // Resets the decoder
    close(): void // Closes the decoder
  }

  interface ImageTrack {
    readonly animated: boolean // Whether the image is animated
    readonly frameCount: number // Number of frames in the image
    readonly repetitionCount: number // Number of times the animation repeats (-1 for infinite)
  }
}

// Ensure the file is treated as a module
export {}
