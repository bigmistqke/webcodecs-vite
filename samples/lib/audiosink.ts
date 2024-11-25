/// <reference path="../audio-worklet.d.ts" />

import { RingBuffer } from '../third_party/ringbufjs/ringbuf.ts'

class AudioSink extends AudioWorkletProcessor {
  consumerSide: RingBuffer
  mediaChannelCount: number
  deinterleaveBuffer: Float32Array

  constructor(options: { processorOptions: { sab: SharedArrayBuffer; mediaChannelCount: any } }) {
    super()
    let sab = options.processorOptions.sab
    this.consumerSide = new RingBuffer(sab, Float32Array)
    this.mediaChannelCount = options.processorOptions.mediaChannelCount
    // https://www.w3.org/TR/webaudio/#render-quantum-size
    const RENDER_QUANTUM_SIZE = 128
    this.deinterleaveBuffer = new Float32Array(this.mediaChannelCount * RENDER_QUANTUM_SIZE)
  }

  // Deinterleave audio data from input (linear Float32Array) to output, an
  // array of Float32Array.
  deinterleave(input: Float32Array, output: Array<Float32Array>) {
    let inputIdx = 0
    let outputChannelCount = output.length
    for (var i = 0; i < output[0].length; i++) {
      for (var j = 0; j < outputChannelCount; j++) {
        output[j][i] = input[inputIdx++]
      }
    }
  }
  process(
    inputs: Array<Array<Float32Array>>,
    outputs: Array<Array<Float32Array>>,
    parameters: Record<string, Float32Array>,
  ) {
    if (this.consumerSide.pop(this.deinterleaveBuffer) != this.deinterleaveBuffer.length) {
      console.log('Warning: audio underrun')
    }
    this.deinterleave(this.deinterleaveBuffer, outputs[0])
    return true
  }
}

registerProcessor('AudioSink', AudioSink)
