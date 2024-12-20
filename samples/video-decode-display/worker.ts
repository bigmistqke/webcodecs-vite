import { MP4Demuxer } from './demuxer_mp4.ts'
import { Canvas2DRenderer } from './renderer_2d.ts'
import { WebGLRenderer } from './renderer_webgl.ts'
import { WebGPURenderer } from './renderer_webgpu.ts'

// Status UI. Messages are batched per animation frame.
let pendingStatus: null | Record<string, string> = null
// Rendering. Drawing is limited to once per animation frame.
let renderer: null | Canvas2DRenderer | WebGLRenderer | WebGPURenderer = null
let pendingFrame: null | VideoFrame = null
let startTime: null | number = null
let frameCount = 0

function setStatus(type: string, message: string) {
  if (pendingStatus) {
    pendingStatus[type] = message
  } else {
    pendingStatus = { [type]: message }
    self.requestAnimationFrame(statusAnimationFrame)
  }
}

function statusAnimationFrame() {
  self.postMessage(pendingStatus)
  pendingStatus = null
}

function renderFrame(frame: VideoFrame) {
  if (!pendingFrame) {
    // Schedule rendering in the next animation frame.
    requestAnimationFrame(renderAnimationFrame)
  } else {
    // Close the current pending frame before replacing it.
    pendingFrame.close()
  }
  // Set or replace the pending frame.
  pendingFrame = frame
}

function renderAnimationFrame() {
  if (pendingFrame && renderer) {
    renderer.draw(pendingFrame)
  }
  pendingFrame = null
}

// Startup.

// Listen for the start request.
self.addEventListener(
  'message',
  message => {
    const { dataUri, rendererName, canvas } = message.data
    // Pick a renderer to use.
    switch (rendererName) {
      case '2d':
        renderer = new Canvas2DRenderer(canvas)
        break
      case 'webgl':
        renderer = new WebGLRenderer(rendererName, canvas)
        break
      case 'webgl2':
        renderer = new WebGLRenderer(rendererName, canvas)
        break
      case 'webgpu':
        renderer = new WebGPURenderer(canvas)
        break
    }

    // Set up a VideoDecoder.
    const decoder = new VideoDecoder({
      output(frame) {
        // Update statistics.
        if (startTime == null) {
          startTime = performance.now()
        } else {
          const elapsed = (performance.now() - startTime) / 1000
          const fps = ++frameCount / elapsed
          setStatus('render', `${fps.toFixed(0)} fps`)
        }

        // Schedule the frame to be rendered.
        renderFrame(frame)
      },
      error(e) {
        setStatus('decode', e)
      },
    })

    // Fetch and demux the media data.
    new MP4Demuxer(dataUri, {
      onConfig(config) {
        setStatus('decode', `${config.codec} @ ${config.codedWidth}x${config.codedHeight}`)
        decoder.configure(config)
      },
      onChunk(chunk) {
        decoder.decode(chunk)
      },
      setStatus,
    })
  },
  { once: true },
)
