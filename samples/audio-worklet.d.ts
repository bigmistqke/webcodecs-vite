declare class AudioWorkletProcessor {
  /**
   * Provides a message port for communication between the AudioWorkletNode
   * and the AudioWorkletProcessor.
   */
  readonly port: MessagePort

  /**
   * Called for each audio processing block.
   *
   * @param inputs - An array of input audio channels. Each input is an array of Float32Array.
   * @param outputs - An array of output audio channels. Each output is an array of Float32Array.
   * @param parameters - A record mapping parameter names to Float32Array values.
   * @returns `true` to keep processing, `false` to stop.
   */
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean

  constructor()
}

/**
 * Registers an AudioWorkletProcessor for use in an AudioWorkletNode.
 *
 * @param name - A string name for the processor.
 * @param processorCtor - The constructor of the processor class.
 */
declare function registerProcessor(name: string, processorCtor: typeof AudioWorkletProcessor): void
