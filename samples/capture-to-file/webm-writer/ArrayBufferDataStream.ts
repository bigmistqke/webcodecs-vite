/**
 * A tool for presenting an ArrayBuffer as a stream for writing some simple data
 * types.
 *
 * By Nicholas Sherlock, with updates from jimbankoski
 *
 * - make it work off frames with timestamps from webcodecs
 * - make it write via Native File IO apis instead of FileWriter
 * - remove alpha and transparency
 * -
 *
 * Released under the WTFPLv2 https://en.wikipedia.org/wiki/WTFPL
 */

/*
 * Create an ArrayBuffer of the given length and present it as a writable stream
 * with methods for writing data in different formats.
 */
export class ArrayBufferDataStream {
  data: Uint8Array
  pos: number

  constructor(length: number) {
    this.data = new Uint8Array(length)
    this.pos = 0
  }

  seek(toOffset: any) {
    this.pos = toOffset
  }

  writeBytes(arr: ArrayLike<number>) {
    for (let i = 0; i < arr.length; i++) {
      this.data[this.pos++] = arr[i]
    }
  }

  writeByte(b: any) {
    this.data[this.pos++] = b
  }

  writeU8 = this.writeByte

  writeU16BE(u: number) {
    this.data[this.pos++] = u >> 8
    this.data[this.pos++] = u
  }

  writeDoubleBE(d: number) {
    let bytes = new Uint8Array(new Float64Array([d]).buffer)

    for (let i = bytes.length - 1; i >= 0; i--) {
      this.writeByte(bytes[i])
    }
  }

  writeFloatBE(d: number) {
    let bytes = new Uint8Array(new Float32Array([d]).buffer)

    for (let i = bytes.length - 1; i >= 0; i--) {
      this.writeByte(bytes[i])
    }
  }

  /**
   * Write an ASCII string to the stream
   */
  writeString(s: string) {
    for (let i = 0; i < s.length; i++) {
      this.data[this.pos++] = s.charCodeAt(i)
    }
  }

  /**
   * Write the given 32-bit integer to the stream as an EBML variable-length
   * integer using the given byte width (use measureEBMLVarInt).
   *
   * No error checking is performed to ensure that the supplied width is correct
   * for the integer.
   *
   * @param i Integer to be written
   * @param width Number of bytes to write to the stream
   */
  writeEBMLVarIntWidth(i: number, width: number) {
    switch (width) {
      case 1:
        this.writeU8((1 << 7) | i)
        break
      case 2:
        this.writeU8((1 << 6) | (i >> 8))
        this.writeU8(i)
        break
      case 3:
        this.writeU8((1 << 5) | (i >> 16))
        this.writeU8(i >> 8)
        this.writeU8(i)
        break
      case 4:
        this.writeU8((1 << 4) | (i >> 24))
        this.writeU8(i >> 16)
        this.writeU8(i >> 8)
        this.writeU8(i)
        break
      case 5:
        /*
         * JavaScript converts its doubles to 32-bit integers for bitwise
         * operations, so we need to do a division by 2^32 instead of a
         * right-shift of 32 to retain those top 3 bits
         */
        this.writeU8((1 << 3) | ((i / 4294967296) & 0x7))
        this.writeU8(i >> 24)
        this.writeU8(i >> 16)
        this.writeU8(i >> 8)
        this.writeU8(i)
        break
      default:
        throw new Error('Bad EBML VINT size ' + width)
    }
  }

  /**
   * Return the number of bytes needed to encode the given integer as an EBML
   * VINT.
   */
  measureEBMLVarInt(val: string | number) {
    if (val < (1 << 7) - 1) {
      /* Top bit is set, leaving 7 bits to hold the integer, but we can't store
       * 127 because "all bits set to one" is a reserved value. Same thing for the
       * other cases below:
       */
      return 1
    } else if (val < (1 << 14) - 1) {
      return 2
    } else if (val < (1 << 21) - 1) {
      return 3
    } else if (val < (1 << 28) - 1) {
      return 4
    } else if (val < 34359738367) {
      // 2 ^ 35 - 1 (can address 32GB)
      return 5
    } else {
      throw new Error('EBML VINT size not supported ' + val)
    }
  }

  writeEBMLVarInt(i: any) {
    this.writeEBMLVarIntWidth(i, this.measureEBMLVarInt(i))
  }

  /**
   * Write the given unsigned 32-bit integer to the stream in big-endian order
   * using the given byte width. No error checking is performed to ensure that the
   * supplied width is correct for the integer.
   *
   * Omit the width parameter to have it determined automatically for you.
   *
   * @param u Unsigned integer to be written
   * @param width Number of bytes to write to the stream
   */
  writeUnsignedIntBE(u: number, width?: number) {
    if (width === undefined) {
      width = this.measureUnsignedInt(u)
    }

    // Each case falls through:
    switch (width) {
      case 5:
        this.writeU8(Math.floor(u / 4294967296)) // Need to use division to access >32
      // bits of floating point var
      case 4:
        this.writeU8(u >> 24)
      case 3:
        this.writeU8(u >> 16)
      case 2:
        this.writeU8(u >> 8)
      case 1:
        this.writeU8(u)
        break
      default:
        throw new Error('Bad UINT size ' + width)
    }
  }

  /**
   * Return the number of bytes needed to hold the non-zero bits of the given
   * unsigned integer.
   */
  measureUnsignedInt(val: number) {
    // Force to 32-bit unsigned integer
    if (val < 1 << 8) {
      return 1
    } else if (val < 1 << 16) {
      return 2
    } else if (val < 1 << 24) {
      return 3
    } else if (val < 4294967296) {
      return 4
    } else {
      return 5
    }
  }

  /**
   * Return a view on the portion of the buffer from the beginning to the current
   * seek position as a Uint8Array.
   */
  getAsDataArray() {
    if (this.pos < this.data.byteLength) {
      return this.data.subarray(0, this.pos)
    } else if (this.pos == this.data.byteLength) {
      return this.data
    } else {
      throw new Error("ArrayBufferDataStream's pos lies beyond end of buffer")
    }
  }
}
