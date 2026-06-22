// AudioWorklet: captures mic, resamples to 16kHz int16, posts chunks
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.targetRate || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.buffer = [];
    this.chunkSamples = this.targetRate / 10; // 100ms chunks
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    for (let i = 0; i < input.length; i += this.ratio) {
      const sample = input[Math.floor(i)];
      this.buffer.push(Math.max(-32768, Math.min(32767, Math.round(sample * 32768))));
    }

    while (this.buffer.length >= this.chunkSamples) {
      const chunk = new Int16Array(this.buffer.splice(0, this.chunkSamples));
      this.port.postMessage(chunk.buffer, [chunk.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
