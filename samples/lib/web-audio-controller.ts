import audiosink from './audiosink.ts?url'

// Simple wrapper class for creating AudioWorklet, connecting it to an
// AudioContext, and controlling audio playback.
export class WebAudioController {
  audioContext: AudioContext
  audioSink?: AudioWorkletNode
  volumeGainNode: GainNode

  constructor(
    sampleRate: number,
    private channelCount: number,
    private sharedArrayBuffer: SharedArrayBuffer,
  ) {
    // Set up AudioContext to house graph of AudioNodes and control rendering.
    this.audioContext = new AudioContext({
      sampleRate: sampleRate,
      latencyHint: 'playback',
    })
    this.audioContext.suspend()
    this.volumeGainNode = new GainNode(this.audioContext)

    // Make script modules available for execution by AudioWorklet.
    this.audioContext.audioWorklet.addModule(audiosink).then(async () => {
      // Get an instance of the AudioSink worklet, passing it the memory for a
      // ringbuffer, connect it to a GainNode for volume. This GainNode is in
      // turn connected to the destination.
      this.audioSink = new AudioWorkletNode(this.audioContext, 'AudioSink', {
        processorOptions: {
          sab: this.sharedArrayBuffer,
          mediaChannelCount: this.channelCount,
        },
        outputChannelCount: [this.channelCount],
      })
      this.audioSink.connect(this.volumeGainNode).connect(this.audioContext.destination)
    })
  }

  setVolume(volume: number) {
    if (volume < 0.0 && volume > 1.0) return

    // Smooth exponential volume ramps on change
    this.volumeGainNode?.gain.setTargetAtTime(volume, this.audioContext!.currentTime, 0.3)
  }

  async play() {
    return this.audioContext?.resume()
  }

  async pause() {
    return this.audioContext?.suspend()
  }

  getMediaTimeInSeconds() {
    // The currently rendered audio sample is the current time of the
    // AudioContext, offset by the total output latency, that is composed of
    // the internal buffering of the AudioContext (e.g., double buffering), and
    // the inherent latency of the audio playback system: OS buffering,
    // hardware buffering, etc. This starts out negative, because it takes some
    // time to buffer, and crosses zero as the first audio sample is produced
    // by the audio output device.
    let totalOutputLatency = this.audioContext!.outputLatency + this.audioContext!.baseLatency

    return Math.max(this.audioContext!.currentTime - totalOutputLatency, 0.0)
  }
}
