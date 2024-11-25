import Plotly from 'plotly.js-dist-min'
import Worker from './stream_worker.ts?worker'

interface MediaConfig {
  alpha: string
  latencyMode: string
  bitrateMode: string
  codec: string
  width: number
  height: number
  hardwareAcceleration: string
  decHwAcceleration: string
  bitrate: number
  framerate: number
  keyInterval: number
  ssrc: number
  scalabilityMode?: string
  avc?: { format: 'annexb' }
  hevc?: { format: 'annexb' }
  id?: string
  pt?: number
}

interface DisplayMetrics {
  frameno: number
  elapsed: number
  g2g: number
  captureTime: number
  expectedDisplayTime: number
  processingDuration: number
  fps: number
  mediaTime: number
  rtpTimestamp: number
  receiveTime: number
}

interface Metrics {
  output: number
  presentedFrames: number
  fps: number
  elapsed: number
  mediaTime: number
  captureTime: number
  expectedDisplayTime: number
  processingDuration: number
  receiveTime: number
  rtpTimestamp: number
}

let preferredResolution
let mediaStream: MediaStream
let bitrate = 300000
let stopped = false
let preferredCodec = 'H264'
let mode = 'L1T1'
let latencyPref = 'realtime'
let bitPref = 'variable'
let encHw = 'no-preference'
let decHw = 'no-preference'
let streamWorker: Worker
let inputStream: { cancel: () => void }, outputStream: { abort: () => void }
let metrics = {
  all: [] as Array<Metrics>,
}
let e2e = {
  all: [] as Array<Array<number>>,
}
let display_metrics = {
  all: [] as Array<DisplayMetrics>,
}

const rate = document.querySelector('#rate') as HTMLInputElement
const framer = document.querySelector('#framer') as HTMLInputElement
const keygap = document.getElementById('keygap') as HTMLInputElement
const rateInput = document.querySelector('#rateInput') as HTMLDivElement
const frameInput = document.querySelector('#frameInput') as HTMLDivElement
const keyInput = document.querySelector('#keyInput') as HTMLDivElement
const startButton = document.querySelector('#start') as HTMLButtonElement
const stopButton = document.querySelector('#stop') as HTMLButtonElement
const codecButtons = document.querySelector('#codecButtons') as HTMLDivElement
const resButtons = document.querySelector('#resButtons') as HTMLDivElement
const prefButtons = document.querySelector('#prefButtons') as HTMLDivElement
const bitButtons = document.querySelector('#bitButtons') as HTMLDivElement
const modeButtons = document.querySelector('#modeButtons') as HTMLDivElement
const decHwButtons = document.querySelector('#decHwButtons') as HTMLDivElement
const encHwButtons = document.querySelector('#encHwButtons') as HTMLDivElement
const chart2_div = document.querySelector('#chart2_div') as HTMLDivElement
const chart3_div = document.querySelector('#chart3_div') as HTMLDivElement
const chart4_div = document.querySelector('#chart4_div') as HTMLDivElement
const videoSelect = document.querySelector('select#videoSource') as HTMLSelectElement
const outputVideo = document.querySelector('#outputVideo') as HTMLVideoElement
const inputVideo = document.querySelector('#inputVideo') as HTMLVideoElement
const selectors = [videoSelect]
let videoSource: number
chart2_div.style.display = 'none'
chart3_div.style.display = 'none'
chart4_div.style.display = 'none'
startButton.disabled = false
stopButton.disabled = true

videoSelect.onchange = function () {
  videoSource = +videoSelect.value
}

interface Constraints {
  video: {
    width: number | { min: number } | { exact: number }
    height: number | { min: number } | { exact: number }
  }
  deviceId?: number | { exact: number }
}

const qvgaConstraints: Constraints = { video: { width: 320, height: 240 } }
const vgaConstraints: Constraints = { video: { width: 640, height: 480 } }
const hdConstraints: Constraints = { video: { width: 1280, height: 720 } }
const fullHdConstraints: Constraints = { video: { width: { min: 1920 }, height: { min: 1080 } } }
const tv4KConstraints: Constraints = { video: { width: { exact: 3840 }, height: { exact: 2160 } } }
const cinema4KConstraints: Constraints = {
  video: { width: { exact: 4096 }, height: { exact: 2160 } },
}
const eightKConstraints: Constraints = { video: { width: { min: 7680 }, height: { min: 4320 } } }

let constraints = qvgaConstraints

function metrics_update(data: any) {
  metrics.all.push(data)
}

function metrics_report() {
  metrics.all.sort((a, b) => {
    return 100000 * (b.captureTime - a.captureTime) + b.output - a.output
  })
  //addToEventLog('Metrics dump: ' + JSON.stringify(metrics.all));
  const len = metrics.all.length
  if (len < 2) return
  for (let i = 0; i < len; i++) {
    if (metrics.all[i].output == 1) {
      const frameno = metrics.all[i].presentedFrames
      const fps = metrics.all[i].fps
      const elapsed = metrics.all[i].elapsed
      const mediaTime = metrics.all[i].mediaTime
      const captureTime = metrics.all[i].captureTime
      const expectedDisplayTime = metrics.all[i].expectedDisplayTime
      const processingDuration = metrics.all[i].processingDuration
      const receiveTime = metrics.all[i].receiveTime
      const rtpTimestamp = metrics.all[i].rtpTimestamp
      const g2g = Math.max(0, expectedDisplayTime - captureTime)
      const data = [frameno, g2g]
      const info = {
        frameno: frameno,
        elapsed: elapsed,
        g2g: g2g,
        captureTime: captureTime,
        expectedDisplayTime: expectedDisplayTime,
        processingDuration: processingDuration,
        fps: fps,
        mediaTime: mediaTime,
        rtpTimestamp: rtpTimestamp,
        receiveTime: receiveTime,
      }
      e2e.all.push(data)
      display_metrics.all.push(info)
    }
  }
  //addToEventLog('E2E Data dump: ' + JSON.stringify(e2e.all));
  //addToEventLog('Output Data dump: ' + JSON.stringify(display_metrics.all));
  return {
    count: metrics.all.length,
  }
}

function addToEventLog(text: string, severity = 'info') {
  let log = document.querySelector('textarea') as HTMLTextAreaElement
  log.value += 'log-' + severity + ': ' + text + '\n'
  if (severity == 'fatal') stop()
}

function gotDevices(deviceInfos: { deviceId: string; kind: string; label: string }[]) {
  // Handles being called several times to update labels. Preserve values.
  const values = selectors.map(select => select.value)
  selectors.forEach(select => {
    while (select.firstChild) {
      select.removeChild(select.firstChild)
    }
  })
  for (let i = 0; i !== deviceInfos.length; ++i) {
    const deviceInfo = deviceInfos[i]
    const option = document.createElement('option')
    option.value = deviceInfo.deviceId
    if (deviceInfo.kind === 'videoinput') {
      option.text = deviceInfo.label || `camera ${videoSelect.length + 1}`
      videoSelect.appendChild(option)
    }
  }
  selectors.forEach((select, selectorIndex) => {
    if (
      Array.prototype.slice.call(select.childNodes).some(n => n.value === values[selectorIndex])
    ) {
      select.value = values[selectorIndex]
    }
  })
}

async function getResValue(radio: { value: any }) {
  preferredResolution = radio.value
  addToEventLog('Resolution selected: ' + preferredResolution)
  switch (preferredResolution) {
    case 'qvga':
      constraints = qvgaConstraints
      break
    case 'vga':
      constraints = vgaConstraints
      break
    case 'hd':
      constraints = hdConstraints
      break
    case 'full-hd':
      constraints = fullHdConstraints
      break
    case 'tv4K':
      constraints = tv4KConstraints
      break
    case 'cinema4K':
      constraints = cinema4KConstraints
      break
    case 'eightK':
      constraints = eightKConstraints
      break
    default:
      constraints = qvgaConstraints
      break
  }
  // Get a MediaStream from the webcam, and reset the resolution.
  try {
    //stop the tracks
    if (mediaStream) {
      mediaStream.getTracks().forEach((track: { stop: () => void }) => {
        track.stop()
      })
    }
    gotDevices(await navigator.mediaDevices.enumerateDevices())
    constraints.deviceId = videoSource ? { exact: videoSource } : undefined
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints)
    inputVideo.srcObject = mediaStream
  } catch (e) {
    addToEventLog(`EnumerateDevices or gUM error: ${e.message}`)
  }
}

function getPrefValue(radio: { value: string }) {
  latencyPref = radio.value
  addToEventLog('Latency preference selected: ' + latencyPref)
}

function getBitPrefValue(radio: { value: string }) {
  bitPref = radio.value
  addToEventLog('Bitrate mode selected: ' + bitPref)
}

function getCodecValue(radio: { value: string }) {
  preferredCodec = radio.value
  addToEventLog('Codec selected: ' + preferredCodec)
}

function getModeValue(radio: { value: string }) {
  mode = radio.value
  addToEventLog('Mode selected: ' + mode)
}

function getDecHwValue(radio: { value: string }) {
  decHw = radio.value
  addToEventLog('Decoder Hardware Acceleration preference: ' + decHw)
}

function getEncHwValue(radio: { value: string }) {
  encHw = radio.value
  addToEventLog('Encoder Hardware Acceleration preference: ' + encHw)
}

function stop() {
  stopped = true
  stopButton.disabled = true
  startButton.disabled = true
  chart2_div.style.display = 'initial'
  chart3_div.style.display = 'initial'
  chart4_div.style.display = 'initial'
  streamWorker.postMessage({ type: 'stop' })
  try {
    inputStream.cancel()
    addToEventLog('inputStream cancelled')
  } catch (e) {
    addToEventLog(`Could not cancel inputStream: ${e.message}`)
  }
  try {
    outputStream.abort()
    addToEventLog('outputStream aborted')
  } catch (e) {
    addToEventLog(`Could not abort outputStream: ${e.message}`)
  }
}

document.addEventListener(
  'DOMContentLoaded',
  async function (event) {
    if (stopped) return
    addToEventLog('DOM Content Loaded')

    // Need to support standard mediacapture-transform implementations

    if (
      typeof MediaStreamTrackProcessor === 'undefined' ||
      typeof MediaStreamTrackGenerator === 'undefined'
    ) {
      addToEventLog('Your browser does not support the MSTP and MSTG APIs.', 'fatal')
      return
    }

    try {
      gotDevices(await navigator.mediaDevices.enumerateDevices())
    } catch (e) {
      addToEventLog('Error in Device enumeration')
    }
    constraints.deviceId = videoSource ? { exact: videoSource } : undefined
    // Get a MediaStream from the webcam.
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints)
    // Connect the webcam stream to the video element.
    inputVideo.srcObject = mediaStream
    // Create a new worker.
    streamWorker = new Worker()
    addToEventLog('Worker created.')

    streamWorker.addEventListener(
      'message',
      function (e) {
        let labels: string | Array<string> = ''
        if (e.data.severity != 'chart') {
          addToEventLog('Worker msg: ' + e.data.text, e.data.severity)
        } else {
          if (e.data.text == '') {
            metrics_report() // sets e2e.all and display_metrics
            e.data.text = JSON.stringify(e2e.all)
            labels = e2e.all.map((item, index) => {
              return Object.keys(display_metrics.all[index])
                .map(key => {
                  return `${key}: ${display_metrics.all[index][key as keyof DisplayMetrics]}`
                })
                .join('<br>')
            })
          }
          const parsed = JSON.parse(e.data.text)
          const x = parsed.map((item: any[]) => item[0])
          const y = parsed.map((item: any[]) => item[1])
          // TODO: more options needed from https://plotly.com/javascript/line-and-scatter
          Plotly.newPlot(
            e.data.div,
            [
              {
                x,
                y,
                text: labels,
                mode: 'markers',
                type: 'scatter',
              },
            ],
            {
              xaxis: {
                title: e.data.x,
                autorange: true,
                range: [
                  0,
                  Math.max.apply(null, x) + 100 /* + a bit, 10%-ish to make it look good */,
                ],
              },
              yaxis: {
                title: e.data.y,
                autorange: true,
                //range: [0, Math.max.apply(null, y) /* + a bit, 10%-ish to make it look good */],
              },
              title: e.data.label,
            },
          )
        }
      },
      false,
    )

    stopButton.onclick = () => {
      addToEventLog('Stop button clicked.')
      stop()
    }

    startButton.onclick = () => {
      startButton.disabled = true
      stopButton.disabled = false
      decHwButtons.style.display = 'none'
      encHwButtons.style.display = 'none'
      prefButtons.style.display = 'none'
      bitButtons.style.display = 'none'
      codecButtons.style.display = 'none'
      resButtons.style.display = 'none'
      modeButtons.style.display = 'none'
      rateInput.style.display = 'none'
      frameInput.style.display = 'none'
      keyInput.style.display = 'none'
      startMedia()
    }

    async function startMedia() {
      if (stopped) return
      addToEventLog('startMedia called')
      try {
        // Collect the bitrate
        const rateValue = +rate.value

        // Collect the framerate
        const framerValue = +framer.value

        // Collect the keyframe gap
        const keygapValue = +keygap.value

        // Create a MediaStreamTrackProcessor, which exposes frames from the track
        // as a ReadableStream of VideoFrames, using non-standard Chrome API.
        let [track] = mediaStream.getVideoTracks()
        let ts = track.getSettings()
        const processor = new MediaStreamTrackProcessor(track)
        inputStream = processor.readable

        // Create a MediaStreamTrackGenerator, which exposes a track from a
        // WritableStream of VideoFrames, using non-standard Chrome API.
        const generator = new MediaStreamTrackGenerator({ kind: 'video' })
        outputStream = generator.writable
        outputVideo.srcObject = new MediaStream([generator])

        // Initialize variables
        let paint_count = 0
        let start_time = 0.0

        const recordOutputFrames = (
          now: number,
          metadata: { output: number; time: any; fps: string },
        ) => {
          metadata.output = 1
          metadata.time = now
          if (start_time == 0.0) start_time = now
          let elapsed = (now - start_time) / 1000
          let fps = (++paint_count / elapsed).toFixed(3)
          metadata.fps = fps
          metrics_update(metadata)
          outputVideo.requestVideoFrameCallback(recordOutputFrames)
        }

        outputVideo.requestVideoFrameCallback(recordOutputFrames)

        const recordInputFrames = (
          now: number,
          metadata: { output: number; time: any; fps: string },
        ) => {
          metadata.output = 0
          metadata.time = now
          if (start_time == 0.0) start_time = now
          let elapsed = (now - start_time) / 1000
          let fps = (++paint_count / elapsed).toFixed(3)
          metadata.fps = fps
          metrics_update(metadata)
          inputVideo.requestVideoFrameCallback(recordInputFrames)
        }

        inputVideo.requestVideoFrameCallback(recordInputFrames)

        //Create video Encoder configuration
        const vConfig = {
          keyInterval: keygapValue,
          resolutionScale: 1,
          framerateScale: 1.0,
        }

        let ssrcArr = new Uint32Array(1)
        window.crypto.getRandomValues(ssrcArr)
        const ssrc = ssrcArr[0]
        const framerat = Math.min(framerValue, ts.frameRate! / vConfig.framerateScale)

        const config: MediaConfig = {
          alpha: 'discard',
          latencyMode: latencyPref,
          bitrateMode: bitPref,
          codec: preferredCodec,
          width: ts.width! / vConfig.resolutionScale,
          height: ts.height! / vConfig.resolutionScale,
          hardwareAcceleration: encHw,
          decHwAcceleration: decHw,
          bitrate: rateValue,
          framerate: framerat,
          keyInterval: vConfig.keyInterval,
          ssrc: ssrc,
        }

        if (mode != 'L1T1') {
          config.scalabilityMode = mode
        }

        switch (preferredCodec) {
          case 'H264':
            config.codec = 'avc1.42002A' // baseline profile, level 4.2
            /* config.codec = "avc1.640028"; */
            config.avc = { format: 'annexb' }
            config.pt = 1
            break
          case 'H265':
            config.codec = 'hvc1.1.6.L120.00' // Main profile, level 4.0, main Tier
            // config.codec = "hev1.1.6.L93.B0"; // Main profile, level 3.1, up to 1280 x 720@33.7
            config.hevc = { format: 'annexb' }
            config.pt = 2
            break
          case 'VP8':
            config.codec = 'vp8'
            config.pt = 3
            break
          case 'VP9':
            config.codec = 'vp09.00.10.08' //VP9, Profile 0, level 1, bit depth 8
            config.pt = 4
            break
          case 'AV1':
            config.codec = 'av01.0.08M.08.0.110.09' // AV1 Main Profile, level 4.0, Main tier, 8-bit content, non-monochrome, with 4:2:0 chroma subsampling
            config.pt = 5
            break
        }

        // Transfer the readable stream to the worker, as well as other info from the user interface.
        // NOTE: transferring frameStream and reading it in the worker is more
        // efficient than reading frameStream here and transferring VideoFrames individually.
        streamWorker.postMessage(
          { type: 'stream', config: config, streams: { input: inputStream, output: outputStream } },
          [inputStream, outputStream],
        )
      } catch (e) {
        addToEventLog(e.name + ': ' + e.message, 'fatal')
      }
    }
  },
  false,
)
