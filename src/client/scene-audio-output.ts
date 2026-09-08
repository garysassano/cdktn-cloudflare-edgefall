/** Shared stereo output. Linear below 0.7; a smooth knee approaches 0.85 only during overload. */
export class SceneAudioOutput {
  readonly input: GainNode;
  private readonly ceiling: WaveShaperNode;
  constructor(context: AudioContext) {
    this.input = context.createGain();
    this.input.gain.value = 0.25;
    this.ceiling = context.createWaveShaper();
    const curve = new Float32Array(16385);
    for (let i = 0; i < curve.length; i++) {
      const sample = ((i / (curve.length - 1)) * 2 - 1) * 4,
        magnitude = Math.abs(sample);
      curve[i] =
        magnitude <= 0.7
          ? sample
          : Math.sign(sample) * (0.7 + 0.15 * (1 - Math.exp(-(magnitude - 0.7) / 0.15)));
    }
    this.ceiling.curve = curve;
    this.ceiling.oversample = "4x";
    this.input.connect(this.ceiling);
    this.ceiling.connect(context.destination);
  }
  connect(destination: AudioNode) {
    this.ceiling.connect(destination);
  }
  disconnect(destination: AudioNode) {
    this.ceiling.disconnect(destination);
  }
  dispose() {
    this.input.disconnect();
    this.ceiling.disconnect();
  }
}
