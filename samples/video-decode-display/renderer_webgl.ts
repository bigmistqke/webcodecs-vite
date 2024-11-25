export class WebGLRenderer {
  #canvas: OffscreenCanvas
  #ctx: WebGL2RenderingContext | WebGLRenderingContext

  constructor(type: 'webgl' | 'webgl2', canvas: OffscreenCanvas) {
    this.#canvas = canvas
    this.#ctx = canvas.getContext(type) as WebGL2RenderingContext | WebGLRenderingContext

    const vertexShader = this.#ctx.createShader(this.#ctx.VERTEX_SHADER)!
    this.#ctx.shaderSource(vertexShader, WebGLRenderer.vertexShaderSource)
    this.#ctx.compileShader(vertexShader)
    if (!this.#ctx.getShaderParameter(vertexShader, this.#ctx.COMPILE_STATUS)) {
      throw this.#ctx.getShaderInfoLog(vertexShader)
    }

    const fragmentShader = this.#ctx.createShader(this.#ctx.FRAGMENT_SHADER)!
    this.#ctx.shaderSource(fragmentShader, WebGLRenderer.fragmentShaderSource)
    this.#ctx.compileShader(fragmentShader)
    if (!this.#ctx.getShaderParameter(fragmentShader, this.#ctx.COMPILE_STATUS)) {
      throw this.#ctx.getShaderInfoLog(fragmentShader)
    }

    const shaderProgram = this.#ctx.createProgram()!
    this.#ctx.attachShader(shaderProgram, vertexShader)
    this.#ctx.attachShader(shaderProgram, fragmentShader)
    this.#ctx.linkProgram(shaderProgram)
    if (!this.#ctx.getProgramParameter(shaderProgram, this.#ctx.LINK_STATUS)) {
      throw this.#ctx.getProgramInfoLog(shaderProgram)
    }
    this.#ctx.useProgram(shaderProgram)

    // Vertex coordinates, clockwise from bottom-left.
    const vertexBuffer = this.#ctx.createBuffer()
    this.#ctx.bindBuffer(this.#ctx.ARRAY_BUFFER, vertexBuffer)
    this.#ctx.bufferData(
      this.#ctx.ARRAY_BUFFER,
      new Float32Array([-1.0, -1.0, -1.0, +1.0, +1.0, +1.0, +1.0, -1.0]),
      this.#ctx.STATIC_DRAW,
    )

    const xyLocation = this.#ctx.getAttribLocation(shaderProgram, 'xy')
    this.#ctx.vertexAttribPointer(xyLocation, 2, this.#ctx.FLOAT, false, 0, 0)
    this.#ctx.enableVertexAttribArray(xyLocation)

    // Create one texture to upload frames to.
    const texture = this.#ctx.createTexture()
    this.#ctx.bindTexture(this.#ctx.TEXTURE_2D, texture)
    this.#ctx.texParameteri(this.#ctx.TEXTURE_2D, this.#ctx.TEXTURE_MAG_FILTER, this.#ctx.NEAREST)
    this.#ctx.texParameteri(this.#ctx.TEXTURE_2D, this.#ctx.TEXTURE_MIN_FILTER, this.#ctx.NEAREST)
    this.#ctx.texParameteri(this.#ctx.TEXTURE_2D, this.#ctx.TEXTURE_WRAP_S, this.#ctx.CLAMP_TO_EDGE)
    this.#ctx.texParameteri(this.#ctx.TEXTURE_2D, this.#ctx.TEXTURE_WRAP_T, this.#ctx.CLAMP_TO_EDGE)
  }

  static vertexShaderSource = `
    attribute vec2 xy;

    varying highp vec2 uv;

    void main(void) {
      gl_Position = vec4(xy, 0.0, 1.0);
      // Map vertex coordinates (-1 to +1) to UV coordinates (0 to 1).
      // UV coordinates are Y-flipped relative to vertex coordinates.
      uv = vec2((1.0 + xy.x) / 2.0, (1.0 - xy.y) / 2.0);
    }
  `

  static fragmentShaderSource = `
    varying highp vec2 uv;

    uniform sampler2D texture;

    void main(void) {
      gl_FragColor = texture2D(texture, uv);
    }
  `

  draw(frame: VideoFrame) {
    this.#canvas.width = frame.displayWidth
    this.#canvas.height = frame.displayHeight

    const gl = this.#ctx

    // Upload the frame.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
    frame.close()

    // Configure and clear the drawing area.
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.clearColor(1.0, 0.0, 0.0, 1.0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    // Draw the frame.
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4)
  }
}
