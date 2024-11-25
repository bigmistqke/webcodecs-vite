const fs = null

/**
 * Allows a series of Blob-convertible objects (ArrayBuffer, Blob, String, etc)
 * to be added to a buffer. Seeking and overwriting of blobs is allowed.
 *
 * You can supply a FileWriter, in which case the BlobBuffer is just used as
 * temporary storage before it writes it through to the disk.
 *
 * By Nicholas Sherlock
 *
 * Released under the WTFPLv2 https://en.wikipedia.org/wiki/WTFPL
 *
 * Ported to typescript by bigmisqke
 */

export class BlobBuffer {
  writePromise = Promise.resolve()
  // Current seek offset
  pos = 0
  // One more than the index of the highest byte ever written
  length = 0

  buffer: Array<{ offset: number; length: number }> = []
  fd: unknown
  fileWriter: WritableStream | null = null

  constructor(destination: WritableStream) {
    if (destination && destination.constructor.name === 'FileSystemWritableFileStream') {
      this.fileWriter = destination
    } else if (fs && destination) {
      this.fd = destination
    }
  }

  /**
   * Seek to the given absolute offset.
   *
   * You may not seek beyond the end of the file (this would create a hole
   * and/or allow blocks to be written in non- sequential order, which isn't
   * currently supported by the memory buffer backend).
   */
  seek(offset: number) {
    if (offset < 0) {
      throw new Error('Offset may not be negative')
    }

    if (isNaN(offset)) {
      throw new Error('Offset may not be NaN')
    }

    if (offset > this.length) {
      throw new Error('Seeking beyond the end of file is not allowed')
    }

    this.pos = offset
  }

  /**
   * Write the Blob-convertible data to the buffer at the current seek
   * position.
   *
   * Note: If overwriting existing data, the write must not cross preexisting
   * block boundaries (written data must be fully contained by the extent of a
   * previous write).
   */
  write(data: any) {
    let newEntry = { offset: this.pos, data: data, length: this.#measureData(data) }
    let isAppend = newEntry.offset >= this.length

    this.pos += newEntry.length
    this.length = Math.max(this.length, this.pos)

    // After previous writes complete, perform our write
    this.writePromise = this.writePromise.then(async () => {
      if (this.fd) {
        return new Promise((resolve, reject) => {
          this.#convertToUint8Array(newEntry.data).then(dataArray => {
            let totalWritten = 0,
              buffer = Buffer.from(dataArray.buffer),
              handleWriteComplete = (err: any, written: number, buffer: string | any[]) => {
                totalWritten += written

                if (totalWritten >= buffer.length) {
                  resolve()
                } else {
                  // We still have more to write...
                  fs.write(
                    this.fd,
                    buffer,
                    totalWritten,
                    buffer.length - totalWritten,
                    newEntry.offset + totalWritten,
                    handleWriteComplete,
                  )
                }
              }

            fs.write(this.fd, buffer, 0, buffer.length, newEntry.offset, handleWriteComplete)
          })
        })
      } else if (this.fileWriter) {
        console.log('this happens?')

        return new Promise((resolve, reject) => {
          this.fileWriter
            .seek(newEntry.offset)
            .then(() => {
              this.fileWriter.write(new Blob([newEntry.data]))
            })
            .then(() => {
              resolve()
            })
        })
      } else if (!isAppend) {
        // We might be modifying a write that was already buffered in memory.

        // Slow linear search to find a block we might be overwriting
        for (let i = 0; i < this.buffer.length; i++) {
          let entry = this.buffer[i]

          // If our new entry overlaps the old one in any way...
          if (
            !(
              newEntry.offset + newEntry.length <= entry.offset ||
              newEntry.offset >= entry.offset + entry.length
            )
          ) {
            if (
              newEntry.offset < entry.offset ||
              newEntry.offset + newEntry.length > entry.offset + entry.length
            ) {
              throw new Error('Overwrite crosses blob boundaries')
            }

            if (newEntry.offset == entry.offset && newEntry.length == entry.length) {
              // We overwrote the entire block
              entry.data = newEntry.data

              // We're done
              return
            } else {
              return this.#convertToUint8Array(entry.data)
                .then(entryArray => {
                  entry.data = entryArray
                  return this.#convertToUint8Array(newEntry.data)
                })
                .then(newEntryArray => {
                  newEntry.data = newEntryArray
                  entry.data.set(newEntry.data, newEntry.offset - entry.offset)
                })
            }
          }
        }
        // Else fall through to do a simple append, as we didn't overwrite any
        // pre-existing blocks
      }

      this.buffer.push(newEntry)
    })
  }

  /**
   * Finish all writes to the buffer, returning a promise that signals when
   * that is complete.
   *
   * If a FileWriter was not provided, the promise is resolved with a Blob
   * that represents the completed BlobBuffer contents. You can optionally
   * pass in a mimeType to be used for this blob.
   *
   * If a FileWriter was provided, the promise is resolved with null as the
   * first argument.
   */
  complete(mimeType: any) {
    if (this.fd || this.fileWriter) {
      this.writePromise = this.writePromise.then(() => {
        return null
      })
    } else {
      // After writes complete we need to merge the buffer to give to the
      // caller
      this.writePromise = this.writePromise.then(() => {
        let result = []

        for (let i = 0; i < this.buffer.length; i++) {
          result.push(this.buffer[i].data)
        }

        return new Blob(result, { type: mimeType })
      })
    }

    return this.writePromise
  }

  #convertToUint8Array(thing: unknown) {
    return new Promise((resolve, reject) => {
      if (thing instanceof Uint8Array) {
        resolve(thing)
      } else if (thing instanceof ArrayBuffer || ArrayBuffer.isView(thing)) {
        resolve(new Uint8Array(thing))
      } else if (thing instanceof Blob) {
        resolve(
          this.#readBlobAsBuffer(thing).then(function (buffer) {
            return new Uint8Array(this.buffer)
          }),
        )
      } else {
        // Assume that Blob will know how to read this thing
        resolve(
          this.#readBlobAsBuffer(new Blob([thing])).then(function (buffer) {
            return new Uint8Array(this.buffer)
          }),
        )
      }
    })
  }

  #measureData(data: { byteLength: any; length: any; size: any }) {
    let result = data.byteLength || data.length || data.size

    if (!Number.isInteger(result)) {
      throw new Error('Failed to determine size of element')
    }

    return result
  }

  // Returns a promise that converts the blob to an ArrayBuffer
  #readBlobAsBuffer(blob: Blob) {
    return new Promise(function (resolve, reject) {
      let reader = new FileReader()

      reader.addEventListener('loadend', function () {
        resolve(reader.result)
      })

      reader.readAsArrayBuffer(blob)
    })
  }
}
