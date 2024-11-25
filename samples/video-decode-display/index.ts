import Worker from './worker.ts?worker'

// Play button.
const startButton = document.querySelector('#start') as HTMLButtonElement
const canvas = document.querySelector('canvas') as HTMLCanvasElement

startButton.addEventListener(
  'click',
  () => {
    document.querySelectorAll('input').forEach(input => (input.disabled = true))
    startButton.disabled = true
    start()
  },
  { once: true },
)

// Status UI.
const status = {
  fetch: document.querySelector('#fetch') as HTMLDivElement,
  demux: document.querySelector('#demux') as HTMLDivElement,
  decode: document.querySelector('#decode') as HTMLDivElement,
  render: document.querySelector('#render') as HTMLDivElement,
} as const

function setStatus(message: { data: Partial<Record<keyof typeof status, string>> }) {
  for (const key in message.data) {
    status[key as keyof typeof status].innerText = message.data[key as keyof typeof message.data]!
  }
}

function getVideoCodec() {
  return (document.querySelector('input[name="video_codec"]:checked') as HTMLInputElement).value
}

function getRendererName() {
  return (document.querySelector('input[name="renderer"]:checked') as HTMLInputElement).value
}

// Worker setup.
function start() {
  const videoCodec = getVideoCodec()
  const dataUri = `../data/bbb_video_${videoCodec}_frag.mp4`
  const rendererName = getRendererName()
  const offscreenCanvas = canvas.transferControlToOffscreen()
  const worker = new Worker()
  worker.addEventListener('message', setStatus)
  worker.postMessage({ dataUri, rendererName, canvas: offscreenCanvas }, [offscreenCanvas])
}
