import { AudioRenderer } from '../lib/audio-renderer.ts'
import { VideoRenderer } from '../lib/video-renderer.ts'
import { MP4PullAudioDemuxer, MP4PullVideoDemuxer } from './mp4-pull-demuxer.ts'

let playing = false
let audioRenderer: AudioRenderer
let videoRenderer: VideoRenderer
let lastMediaTimeSecs = 0
let lastMediaTimeCapturePoint = 0

function updateMediaTime(mediaTimeSecs: number, capturedAtHighResTimestamp: number) {
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
  console.info(`Worker message: ${JSON.stringify(e.data)}`)

  switch (e.data.command) {
    case 'initialize':
      let audioDemuxer = new MP4PullAudioDemuxer(e.data.audioFile)
      audioRenderer = new AudioRenderer(audioDemuxer)

      let videoDemuxer = new MP4PullVideoDemuxer(e.data.videoFile)
      videoRenderer = new VideoRenderer(videoDemuxer, e.data.canvas)

      await Promise.all([audioRenderer.ready, videoRenderer.ready])

      postMessage({
        command: 'initialize-done',
        sampleRate: audioRenderer.sampleRate,
        channelCount: audioRenderer.channelCount,
        sharedArrayBuffer: audioRenderer.ringbuffer!.buf,
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
