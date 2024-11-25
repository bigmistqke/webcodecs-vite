import { debugLog } from '../lib/debug-log.ts'
import { WebAudioController } from '../lib/web-audio-controller.ts'
import Worker from './media-worker?worker'

// Transfer canvas to offscreen. Painting will be performed by worker without
// blocking the Window main thread.
const canvas = document.querySelector('canvas') as HTMLCanvasElement
const offscreenCanvas = canvas.transferControlToOffscreen()

// Instantiate the "media worker" and start loading the files. The worker will
// house and drive the demuxers and decoders.
const mediaWorker = new Worker()

const playButton = document.querySelector('button') as HTMLButtonElement
const volume = document.querySelector('#volume') as HTMLInputElement

let initDone = false

let audioController: WebAudioController
let mediaTimeUpdateInterval: number | null = null

function getVideoCodec() {
  return (document.querySelector('input[name="video_codec"]:checked') as HTMLInputElement).value
}

// Set up volume slider.
volume.addEventListener('change', () => audioController.setVolume(+volume.value))

playButton.addEventListener('click', async () => {
  if (!initDone) {
    document.querySelectorAll('input[name="video_codec"]').forEach(input => (input.disabled = true))
    playButton.innerText = 'Loading...'
    playButton.disabled = true

    // Wait for worker initialization. Use metadata to init the WebAudioController.
    await new Promise<void>(resolve => {
      const videoCodec = getVideoCodec()
      mediaWorker.postMessage(
        {
          command: 'initialize',
          audioFile: '../data/bbb_audio_aac_frag.mp4',
          videoFile: `../data/bbb_video_${videoCodec}_frag.mp4`,
          canvas: offscreenCanvas,
        },
        { transfer: [offscreenCanvas] },
      )

      mediaWorker.addEventListener('message', e => {
        console.assert(e.data.command == 'initialize-done')
        audioController = new WebAudioController(
          e.data.sampleRate,
          e.data.channelCount,
          e.data.sharedArrayBuffer,
        )
        initDone = true
        resolve()
      })
    })
    playButton.innerText = 'Play'
    playButton.disabled = false
    volume.disabled = false
  }

  // Enable play now that we're loaded
  if (playButton.innerText == 'Play') {
    debugLog('playback start')

    // Audio can only start in reaction to a user-gesture.
    audioController.play().then(() => debugLog('playback started'))
    mediaWorker.postMessage({
      command: 'play',
      mediaTimeSecs: audioController.getMediaTimeInSeconds(),
      mediaTimeCapturedAtHighResTimestamp: performance.now() + performance.timeOrigin,
    })

    sendMediaTimeUpdates(true)

    playButton.innerText = 'Pause'
  } else {
    debugLog('playback pause')
    // Resolves when audio has effectively stopped, this can take some time if
    // using bluetooth, for example.
    audioController.pause().then(() => {
      debugLog('playback paused')
      // Wait to pause worker until context suspended to ensure we continue
      // filling audio buffer while audio is playing.
      mediaWorker.postMessage({ command: 'pause' })
    })

    sendMediaTimeUpdates(false)

    playButton.innerText = 'Play'
  }
})

// Helper function to periodically send the current media time to the media
// worker. Ideally we would instead compute the media time on the worker thread,
// but this requires WebAudio interfaces to be exposed on the WorkerGlobalScope.
// See https://github.com/WebAudio/web-audio-api/issues/2423

function sendMediaTimeUpdates(enabled: boolean) {
  if (enabled) {
    // Local testing shows this interval (1 second) is frequent enough that the
    // estimated media time between updates drifts by less than 20 msec. Lower
    // values didn't produce meaningfully lower drift and have the downside of
    // waking up the main thread more often. Higher values could make av sync
    // glitches more noticeable when changing the output device.
    const UPDATE_INTERVAL = 1000
    mediaTimeUpdateInterval = setInterval(() => {
      mediaWorker.postMessage({
        command: 'update-media-time',
        mediaTimeSecs: audioController.getMediaTimeInSeconds(),
        mediaTimeCapturedAtHighResTimestamp: performance.now() + performance.timeOrigin,
      })
    }, UPDATE_INTERVAL)
  } else {
    if (mediaTimeUpdateInterval) {
      clearInterval(mediaTimeUpdateInterval)
      mediaTimeUpdateInterval = null
    }
  }
}
