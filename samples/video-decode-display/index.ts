import Worker from './worker.ts?worker'

// Play button.
const startButton = document.querySelector('#start')
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
  fetch: document.querySelector('#fetch'),
  demux: document.querySelector('#demux'),
  decode: document.querySelector('#decode'),
  render: document.querySelector('#render'),
}

function setStatus(message) {
  for (const key in message.data) {
    status[key].innerText = message.data[key]
  }
}

// Worker setup.
function start() {
  const videoCodec = document.querySelector('input[name="video_codec"]:checked').value
  const dataUri = `../data/bbb_video_${videoCodec}_frag.mp4`
  const rendererName = document.querySelector('input[name="renderer"]:checked').value
  const canvas = document.querySelector('canvas').transferControlToOffscreen()
  const worker = new Worker()
  worker.addEventListener('message', setStatus)
  worker.postMessage({ dataUri, rendererName, canvas }, [canvas])
}
