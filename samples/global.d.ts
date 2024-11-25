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
}

// Ensure the file is treated as a module
export {}
