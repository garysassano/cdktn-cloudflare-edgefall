import { COUNTER_LIMIT } from "../../game/core/numeric.js";
import { ProtocolError } from "./schema.js";

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new ProtocolError("malformed", `Wire integer outside [${minimum}, ${maximum}]`);
  return value;
}

export class Writer {
  offset = 0;
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  constructor(length: number) {
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }
  u8(value: number): void {
    this.reserve(1);
    this.view.setUint8(this.offset++, bounded(value, 0, 255));
  }
  u16(value: number): void {
    this.reserve(2);
    this.view.setUint16(this.offset, bounded(value, 0, 65535), true);
    this.offset += 2;
  }
  u32(value: number, minimum = 0, maximum = COUNTER_LIMIT - 1): void {
    this.reserve(4);
    this.view.setUint32(this.offset, bounded(value, minimum, maximum), true);
    this.offset += 4;
  }
  i32(value: number, maximum: number): void {
    this.reserve(4);
    this.view.setInt32(this.offset, bounded(value, -maximum, maximum), true);
    this.offset += 4;
  }
  bool(value: boolean): void {
    if (typeof value !== "boolean") throw new ProtocolError("malformed", "Wire boolean required");
    this.u32(value ? 1 : 0);
  }
  optionalId(value: number | null): void {
    this.u32(value === null ? 0 : value, value === null ? 0 : 1);
  }
  choice<T extends string>(values: readonly T[], value: T): void {
    this.u32(values.indexOf(value), 0, values.length - 1);
  }
  zero(length: number): void {
    this.reserve(length);
    this.offset += length;
  }
  private reserve(length: number): void {
    if (this.offset + length > this.bytes.byteLength)
      throw new ProtocolError("malformed", "Wire writer overrun");
  }
}

export class Reader {
  offset = 0;
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(): number {
    this.reserve(1);
    return this.view.getUint8(this.offset++);
  }
  u16(): number {
    this.reserve(2);
    const result = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return result;
  }
  u32(minimum = 0, maximum = COUNTER_LIMIT - 1): number {
    this.reserve(4);
    const result = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return bounded(result, minimum, maximum);
  }
  i32(maximum: number): number {
    this.reserve(4);
    const result = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return bounded(result, -maximum, maximum);
  }
  bool(): boolean {
    return this.u32(0, 1) === 1;
  }
  choice<T extends string>(values: readonly T[]): T {
    const result = values[this.u32(0, values.length - 1)];
    if (result === undefined) throw new ProtocolError("malformed", "Invalid wire enum");
    return result;
  }
  zero(length: number): void {
    this.reserve(length);
    for (let index = 0; index < length; index++)
      if (this.view.getUint8(this.offset + index) !== 0)
        throw new ProtocolError("malformed", "Nonzero reserved/padding bytes");
    this.offset += length;
  }
  private reserve(length: number): void {
    if (this.offset + length > this.bytes.byteLength)
      throw new ProtocolError("malformed", "Truncated wire record");
  }
}
