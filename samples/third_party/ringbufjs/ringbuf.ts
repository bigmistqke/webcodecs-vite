// A Single Producer - Single Consumer thread-safe wait-free ring buffer.
//
// The producer and the consumer can be on separate threads, but cannot change roles,
// except with external synchronization.

type TypedArrayConstructor =
  | Int8ArrayConstructor
  | Uint8ArrayConstructor
  | Uint8ClampedArrayConstructor
  | Int16ArrayConstructor
  | Uint16ArrayConstructor
  | Int32ArrayConstructor
  | Uint32ArrayConstructor
  | Float32ArrayConstructor
  | Float64ArrayConstructor
  | BigInt64ArrayConstructor
  | BigUint64ArrayConstructor

type TypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array

export class RingBuffer {
  _type: TypedArrayConstructor
  _capacity: number
  buf: SharedArrayBuffer
  write_ptr: Uint32Array
  read_ptr: Uint32Array
  storage: any

  static getStorageForCapacity(capacity: number, type: TypedArrayConstructor) {
    if (!type.BYTES_PER_ELEMENT) {
      throw 'Pass in a ArrayBuffer subclass'
    }
    var bytes = 8 + (capacity + 1) * type.BYTES_PER_ELEMENT
    return new SharedArrayBuffer(bytes)
  }

  /**
   * `sab` is a SharedArrayBuffer with a capacity calculated by calling
   * `getStorageForCapacity` with the desired capacity.
   */
  constructor(sab: SharedArrayBuffer, type: TypedArrayConstructor) {
    if (!ArrayBuffer.__proto__.isPrototypeOf(type) && type.BYTES_PER_ELEMENT !== undefined) {
      throw 'Pass a concrete typed array class as second argument'
    }

    // Maximum usable size is 1<<32 - type.BYTES_PER_ELEMENT bytes in the ring
    // buffer for this version, easily changeable.
    // -4 for the write ptr (uint32_t offsets)
    // -4 for the read ptr (uint32_t offsets)
    // capacity counts the empty slot to distinguish between full and empty.
    this._type = type
    this._capacity = (sab.byteLength - 8) / type.BYTES_PER_ELEMENT
    this.buf = sab
    this.write_ptr = new Uint32Array(this.buf, 0, 1)
    this.read_ptr = new Uint32Array(this.buf, 4, 1)
    this.storage = new type(this.buf, 8, this._capacity)
  }
  /**
   * Returns the type of the underlying ArrayBuffer for this RingBuffer. This
   * allows implementing crude type checking.
   */
  type() {
    return this._type.name
  }

  /**
   * Push bytes to the ring buffer. `elements` is a typed array of the same type
   * as passed in the ctor, to be written to the queue.
   * Returns the number of elements written to the queue.
   */
  push(elements: TypedArray) {
    var rd = Atomics.load(this.read_ptr, 0)
    var wr = Atomics.load(this.write_ptr, 0)

    if ((wr + 1) % this.#storage_capacity() == rd) {
      // full
      return 0
    }

    let to_write = Math.min(this.#available_write(rd, wr), elements.length)
    let first_part = Math.min(this.#storage_capacity() - wr, to_write)
    let second_part = to_write - first_part

    this.#copy(elements, 0, this.storage, wr, first_part)
    this.#copy(elements, first_part, this.storage, 0, second_part)

    // publish the enqueued data to the other side
    Atomics.store(this.write_ptr, 0, (wr + to_write) % this.#storage_capacity())

    return to_write
  }

  /**
   * Write bytes to the ring buffer using callbacks. This create wrapper
   * objects and can GC, so it's best to no use this variant from a real-time
   * thread such as an AudioWorklerProcessor `process` method.
   * The callback is passed two typed arrays of the same type, to be filled.
   * This allows skipping copies if the API that produces the data writes is
   * passed arrays to write to, such as `AudioData.copyTo`.
   */
  writeCallback(amount: number, cb: (first_part_buf: unknown, second_part_buf: unknown) => void) {
    var rd = Atomics.load(this.read_ptr, 0)
    var wr = Atomics.load(this.write_ptr, 0)

    if ((wr + 1) % this.#storage_capacity() == rd) {
      // full
      return 0
    }

    let to_write = Math.min(this.#available_write(rd, wr), amount)
    let first_part = Math.min(this.#storage_capacity() - wr, to_write)
    let second_part = to_write - first_part

    // This part will cause GC: don't use in the real time thread.
    var first_part_buf = new this._type(this.storage.buffer, 8 + wr * 4, first_part)
    var second_part_buf = new this._type(this.storage.buffer, 8 + 0, second_part)

    cb(first_part_buf, second_part_buf)

    // publish the enqueued data to the other side
    Atomics.store(this.write_ptr, 0, (wr + to_write) % this.#storage_capacity())

    return to_write
  }

  /**
   * Read `elements.length` elements from the ring buffer. `elements` is a typed
   * array of the same type as passed in the ctor.
   * Returns the number of elements read from the queue, they are placed at the
   * beginning of the array passed as parameter.
   */
  pop(elements: Float32Array) {
    var rd = Atomics.load(this.read_ptr, 0)
    var wr = Atomics.load(this.write_ptr, 0)

    if (wr == rd) {
      return 0
    }

    let to_read = Math.min(this.#available_read(rd, wr), elements.length)

    let first_part = Math.min(this.#storage_capacity() - rd, to_read)
    let second_part = to_read - first_part

    this.#copy(this.storage, rd, elements, 0, first_part)
    this.#copy(this.storage, 0, elements, first_part, second_part)

    Atomics.store(this.read_ptr, 0, (rd + to_read) % this.#storage_capacity())

    return to_read
  }

  /**
   * True if the ring buffer is empty false otherwise. This can be late on the
   * reader side: it can return true even if something has just been pushed.
   */
  empty() {
    var rd = Atomics.load(this.read_ptr, 0)
    var wr = Atomics.load(this.write_ptr, 0)

    return wr == rd
  }

  /**
   * True if the ring buffer is full, false otherwise. This can be late on the
   * write side: it can return true when something has just been popped.
   */
  full() {
    var rd = Atomics.load(this.read_ptr, 0)
    var wr = Atomics.load(this.write_ptr, 0)

    return (wr + 1) % this.#storage_capacity() == rd
  }

  /**
   * The usable capacity for the ring buffer: the number of elements that can be
   * stored.
   */
  capacity() {
    return this._capacity - 1
  }

  /**
   * Number of elements available for reading. This can be late, and report less
   * elements that is actually in the queue, when something has just been
   * enqueued.
   */
  available_read() {
    var rd = Atomics.load(this.read_ptr, 0)
    var wr = Atomics.load(this.write_ptr, 0)
    return this.#available_read(rd, wr)
  }

  /**
   * Number of elements available for writing. This can be late, and report less
   * elements that is actually available for writing, when something has just
   * been dequeued.
   */
  available_write() {
    var rd = Atomics.load(this.read_ptr, 0)
    var wr = Atomics.load(this.write_ptr, 0)
    return this.#available_write(rd, wr)
  }

  // private methods //

  /**  Number of elements available for reading, given a read and write pointer.. */
  #available_read(rd: number, wr: number) {
    return (wr + this.#storage_capacity() - rd) % this.#storage_capacity()
  }

  /** Number of elements available from writing, given a read and write pointer.  */
  #available_write(rd: number, wr: number) {
    return this.capacity() - this.#available_read(rd, wr)
  }

  /**
   * The size of the storage for elements not accounting the space for the
   * index, counting the empty slot.
   */
  #storage_capacity() {
    return this._capacity
  }

  /**
   * Copy `size` elements from `input`, starting at offset `offset_input`, to
   * `output`, starting at offset `offset_output`.
   */
  #copy(
    input: TypedArray,
    offset_input: number,
    output: TypedArray,
    offset_output: number,
    size: number,
  ) {
    for (var i = 0; i < size; i++) {
      output[offset_output + i] = input[offset_input + i]
    }
  }
}
