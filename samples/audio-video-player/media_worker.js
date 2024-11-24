import { AudioRenderer } from '../lib/audio_renderer'
import { VideoRenderer } from '../lib/video_renderer'
import { MP4PullDemuxer } from './mp4_pull_demuxer.ts'

// The "media worker" houses and drives the AudioRenderer and VideoRenderer
// classes to perform demuxing and decoder I/O on a background worker thread.
console.info(`Worker started`)

// Ideally we would use the static import { module } from ... syntax for this
// and the modules below. But presently mp4box.js does not use ES6 modules,
// so we import it as an old-style script and use the dynamic import() to load
// our modules below.
let moduleLoadedResolver = null
let modulesReady = new Promise(resolver => (moduleLoadedResolver = resolver))
let playing = false
let audioRenderer = null
let videoRenderer = null
let lastMediaTimeSecs = 0
let lastMediaTimeCapturePoint = 0

;(async () => {
  audioRenderer = new AudioRenderer()
  videoRenderer = new VideoRenderer()
  moduleLoadedResolver()
  moduleLoadedResolver = null
  console.info('Worker modules imported')
})()

function updateMediaTime(mediaTimeSecs, capturedAtHighResTimestamp) {
  lastMediaTimeSecs = mediaTimeSecs
  // Translate into Worker's time origin
  lastMediaTimeCapturePoint = capturedAtHighResTimestamp - performance.timeOrigin
}

// Estimate current media time using last given time + offset from now()
function getMediaTimeMicroSeconds() {
  let msecsSinceCapture = performance.now() - lastMediaTimeCapturePoint
  return (lastMediaTimeSecs * 1000 + msecsSinceCapture) * 1000
}

self.addEventListener('message', async function (e) {
  await modulesReady

  console.info(`Worker message: ${JSON.stringify(e.data)}`)

  switch (e.data.command) {
    case 'initialize':
      let audioDemuxer = new MP4PullDemuxer(e.data.audioFile)
      let audioReady = audioRenderer.initialize(audioDemuxer)

      let videoDemuxer = new MP4PullDemuxer(e.data.videoFile)
      let videoReady = videoRenderer.initialize(videoDemuxer, e.data.canvas)
      await Promise.all([audioReady, videoReady])
      postMessage({
        command: 'initialize-done',
        sampleRate: audioRenderer.sampleRate,
        channelCount: audioRenderer.channelCount,
        sharedArrayBuffer: audioRenderer.ringbuffer.buf,
      })
      break
    case 'play':
      playing = true

      updateMediaTime(e.data.mediaTimeSecs, e.data.mediaTimeCapturedAtHighResTimestamp)

      audioRenderer.play()

      self.requestAnimationFrame(function renderVideo() {
        if (!playing) return
        videoRenderer.render(getMediaTimeMicroSeconds())
        self.requestAnimationFrame(renderVideo)
      })
      break
    case 'pause':
      playing = false
      audioRenderer.pause()
      break
    case 'update-media-time':
      updateMediaTime(e.data.mediaTimeSecs, e.data.mediaTimeCapturedAtHighResTimestamp)
      break
    default:
      console.error(`Worker bad message: ${e.data}`)
  }
})
