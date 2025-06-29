import './helpers/text-helpers.js'
import { fileExtMap } from './helpers/file-helpers.js'
import { createError, isError } from './helpers/error-helpers.js'
import { getCurrentVoice } from './helpers/voice-helpers.js'

// Local state -----------------------------------------------------------------
let queue = []
let playing = false
let cancellationToken = false
let bootstrappedResolver = null
const bootstrapped = new Promise((resolve) => (bootstrappedResolver = resolve))

// Bootstrap -------------------------------------------------------------------
;(async function Bootstrap() {
  await setDefaultSettings()
  await handlers.fetchVoices()
  await createContextMenus()
  bootstrappedResolver()
})()

// Event listeners -------------------------------------------------------------
chrome.commands.onCommand.addListener(function (command) {
  console.log('Handling command...', command)

  if (!handlers[command]) throw new Error(`No handler found for ${command}`)

  handlers[command]()
})

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  console.log('Handling message...', request, sender, sendResponse)

  const { id, payload } = request

  if (!handlers[id]) throw new Error(`No handler found for ${id}`)
  handlers[id](payload).then(sendResponse)

  return true
})

chrome.storage.onChanged.addListener(function (changes) {
  console.log('Handling storage change...', changes)

  if (changes.downloadEncoding) {
    updateContextMenus()
  }
})

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  console.log('Handling context menu click...', info, tab)

  const id = info.menuItemId
  const payload = { text: info.selectionText }

  if (!handlers[id]) throw new Error(`No handler found for ${id}`)

  handlers[id](payload)
})

chrome.runtime.onInstalled.addListener(async function (details) {
  console.log('Handling runtime install...', details)

  const self = await chrome.management.getSelf()
  if (details.reason === 'update' && self.installType !== 'development') {
    chrome.tabs.create({ url: 'https://wavenet-for-chrome.com/changelog' })
  }
})

// Handlers --------------------------------------------------------------------
export const handlers = {
  readAloud: async function ({ text }) {
    console.log('Reading aloud...', { text })

    if (playing) await this.stopReading()

    const chunks = text.chunk()
    console.log('Chunked text into', chunks.length, 'chunks', chunks)

    queue.push(...chunks)
    playing = true
    updateContextMenus()

    let count = 0
    const sync = await chrome.storage.sync.get()
    const encoding = sync.readAloudEncoding
    const prefetchQueue = []
    cancellationToken = false
    while (queue.length) {
      if (cancellationToken) {
        cancellationToken = false
        playing = false
        updateContextMenus()
        return
      }

      const text = queue.shift()
      const nextText = queue[0]

      if (nextText) {
        prefetchQueue.push(this.getAudioUri({ text: nextText, encoding }))
      }

      const audioUri =
        count === 0
          ? await this.getAudioUri({ text, encoding })
          : await prefetchQueue.shift()

      try {
        if (isError(audioUri)) return audioUri

        await createOffscreenDocument()
        await chrome.runtime.sendMessage({
          id: 'play',
          payload: { audioUri },
          offscreen: true,
        })
      } catch (e) {
        console.warn('Failed to play audio', e)

        // Audio playback may have failed because the user stopped playback, or
        // called the readAloud function again. We need to return early to avoid
        // playing the next chunk.
        return
      }

      console.log('Play through of audio complete. Enqueuing next chunk.')
      count++
    }

    playing = false
    updateContextMenus()
    return Promise.resolve(true)
  },
  readAloudShortcut: async function () {
    console.log('Handling read aloud shortcut...')

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: retrieveSelection,
    })
    const text = result[0].result

    if (playing) {
      await this.stopReading()

      if (!text) return
    }

    this.readAloud({ text })
  },
  stopReading: async function () {
    console.log('Stopping reading...')

    cancellationToken = true
    queue = []
    playing = false
    updateContextMenus()

    try {
      await createOffscreenDocument()
      await chrome.runtime.sendMessage({
        id: 'stop',
        offscreen: true,
      })
    } catch (e) {
      console.warn('Failed to stop audio', e)
    }

    return Promise.resolve(true)
  },
  download: async function ({ text }) {
    console.log('Downloading audio...', { text })

    const { downloadEncoding: encoding } = await chrome.storage.sync.get()

    const url = await this.getAudioUri({ text, encoding })
    if (isError(url)) return url

    console.log('Downloading audio from', url)

    chrome.downloads.download({
      url,
      filename: `tts-download.${fileExtMap[encoding]}`,
    })

    return Promise.resolve(true)
  },
  downloadShortcut: async function () {
    console.log('Handling download shortcut...')

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: retrieveSelection,
    })
    const text = result[0].result

    this.download({ text })
  },
  synthesize: async function ({ text, encoding }) {
    console.log('Synthesizing text...', { text, encoding })

    const session = await chrome.storage.session.get()
    const sync = await chrome.storage.sync.get()
    const apiKey = sync.apiKey

    if (!apiKey) {
      const error = createError({
        errorCode: 'MISSING_API_KEY',
        errorMessage: 'Missing API key',
        errorTitle:
          "Your Google Cloud API key is missing. Please enter it in the extension's popup.",
      })

      sendMessageToCurrentTab(error)
      return error
    }

    let ssml = undefined
    if (text.isSSML()) {
      ssml = text
      text = undefined
    }

    const url = `${process.env.TTS_API_URL}/text:synthesize?key=${apiKey}`
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: {
            text: text,
            ssml: ssml,
          },
          voice: {
            name: getCurrentVoice(session, sync),
            languageCode: sync.language,
          },
          audioConfig: {
            audioEncoding: encoding,
            pitch: sync.pitch,
            speakingRate: sync.speed,
            volumeGainDb: sync.volumeGainDb,
            effectsProfileId: sync.audioProfile !== 'default' ? [sync.audioProfile] : undefined,
          },
        }),
      })

      if (!response.ok) {
        console.log('Failed to synthesize text', response)
        const errorData = await response.json()
        const message = errorData.error?.message || 'Unknown error occurred'

        if (message.includes('API key not valid')) {
          const error = createError({
            errorCode: 'INVALID_API_KEY',
            errorMessage: 'Invalid API key',
            errorTitle:
              "Your Google Cloud API key is invalid. Please check it in the extension's popup.",
          })

          sendMessageToCurrentTab(error)
          return error
        }

        const error = createError({
          errorCode: 'FAILED_TO_SYNTHESIZE_TEXT',
          errorTitle: 'Failed to synthesize text',
          errorMessage: message,
        })

        sendMessageToCurrentTab(error)
        await this.stopReading()
        return error
      }

      const result = await response.json()
      return result.audioContent
    } catch (e) {
      const error = createError({
        errorCode: 'FAILED_TO_SYNTHESIZE_TEXT',
        errorTitle: 'Failed to synthesize text',
        errorMessage: 'Network error or API unavailable. Please try again.',
      })

      sendMessageToCurrentTab(error)
      await this.stopReading()
      return error
    }
  },
  getAudioUri: async function ({ text, encoding }) {
    console.log('Getting audio URI...', { text, encoding })

    const chunks = text.chunk()
    console.log('Chunked text into', chunks.length, 'chunks', chunks)

    const promises = chunks.map((text) => this.synthesize({ text, encoding }))
    const audioContents = await Promise.all(promises)
    const errorContents = audioContents.filter(isError)

    if (errorContents.length) {
      return errorContents[0]
    }

    return (
      `data:audio/${fileExtMap[encoding]};base64,` +
      btoa(audioContents.map(atob).join(''))
    )
  },
  validateApiKey: async function () {
    console.log('Validating API key...')
    const sync = await chrome.storage.sync.get()

    try {
      const response = await fetch(
        `${process.env.TTS_API_URL}/voices?key=${sync.apiKey}`,
      )
      return response.ok
    } catch (e) {
      return false
    }
  },
  fetchVoices: async function () {
    console.log('Fetching voices...')
    const sync = await chrome.storage.sync.get()
    
    if (!sync.apiKey) {
      console.warn('No API key found, cannot fetch voices')
      return []
    }

    try {
      const response = await fetch(`${process.env.TTS_API_URL}/voices?key=${sync.apiKey}`)
      if (!response.ok) throw new Error('Failed to fetch voices')

      const data = await response.json()
      const voices = data.voices || []

      await chrome.storage.session.set({ voices })
      await setLanguages()
      return voices
    } catch (e) {
      console.error('Failed to fetch voices:', e)
      return []
    }
  },
}

// Helpers ---------------------------------------------------------------------
async function updateContextMenus() {
  console.log('Updating context menus...', { playing })

  // Prevents context menus from being updated before they are created,
  // which causes an unnecessary error in the console.
  await bootstrapped

  const commands = await chrome.commands.getAll()
  const encoding = (await chrome.storage.sync.get()).downloadEncoding
  const fileExt = fileExtMap[encoding]
  const downloadShortcut = commands.find((c) => c.name === 'downloadShortcut')
    ?.shortcut

  chrome.contextMenus.update('readAloud', {
    enabled: true,
  })

  chrome.contextMenus.update('stopReading', {
    enabled: playing,
  })

  chrome.contextMenus.update('download', {
    title: `Download ${fileExt?.toUpperCase()}${
      downloadShortcut && ` (${downloadShortcut})`
    }`,
  })
}

async function createContextMenus() {
  console.log('Creating context menus...')
  chrome.contextMenus.removeAll()

  const commands = await chrome.commands.getAll()
  const readAloudShortcut = commands.find((c) => c.name === 'readAloudShortcut')
    ?.shortcut
  const downloadShortcut = commands.find((c) => c.name === 'downloadShortcut')
    ?.shortcut
  const downloadEncoding = (await chrome.storage.sync.get()).downloadEncoding
  const fileExt = fileExtMap[downloadEncoding]

  chrome.contextMenus.create({
    id: 'readAloud',
    title: `Read aloud${readAloudShortcut && ` (${readAloudShortcut})`}`,
    contexts: ['selection'],
    enabled: !playing,
  })

  chrome.contextMenus.create({
    id: 'stopReading',
    title: `Stop reading${readAloudShortcut && ` (${readAloudShortcut})`}`,
    contexts: ['all'],
    enabled: playing,
  })

  chrome.contextMenus.create({
    id: 'download',
    title: `Download ${fileExt?.toUpperCase()}${
      downloadShortcut && ` (${downloadShortcut})`
    }`,
    contexts: ['selection'],
  })
}

let creating
async function createOffscreenDocument() {
  const path = 'public/offscreen.html'

  if (await hasOffscreenDocument(path)) return

  if (creating) {
    await creating
  } else {
    creating = chrome.offscreen.createDocument({
      url: path,
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: 'Plays synthesized audio in the background',
    })
    await creating
    creating = null
  }
}

async function hasOffscreenDocument(path) {
  console.log('Checking if offscreen document exists...')

  const offscreenUrl = chrome.runtime.getURL(path)
  // @ts-ignore
  const matchedClients = await clients.matchAll()

  for (const client of matchedClients) {
    if (client.url === offscreenUrl) return true
  }

  return false
}

async function setDefaultSettings() {
  console.info('Setting default settings...')

  await chrome.storage.session.setAccessLevel({
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
  })

  const sync = await chrome.storage.sync.get()

  await chrome.storage.sync.set({
    language: sync.language || 'en-US',
    speed: sync.speed || 1,
    pitch: sync.pitch || 0,
    voices: sync.voices || { 'en-US': 'en-US-Journey-F' },
    readAloudEncoding: sync.readAloudEncoding || 'OGG_OPUS',
    downloadEncoding: sync.downloadEncoding || 'MP3',
    apiKey: sync.apiKey || '',
    audioProfile: sync.audioProfile || 'default',
    volumeGainDb: sync.volumeGainDb || 0,
  })
}

async function setLanguages() {
  console.log('Setting languages...')

  const session = await chrome.storage.session.get()

  if (!session.voices) {
    throw new Error('No voices found. Cannot set languages.')
  }

  const languages = new Set(
    session.voices.map((voice) => voice.languageCodes).flat(),
  )

  await chrome.storage.session.set({ languages: Array.from(languages) })

  return languages
}

function retrieveSelection() {
  console.log('Retrieving selection...')

  const activeElement = document.activeElement
  if (
    activeElement?.tagName === 'INPUT' ||
    activeElement?.tagName === 'TEXTAREA'
  ) {
    const start = (activeElement as HTMLInputElement).selectionStart
    const end = (activeElement as HTMLInputElement).selectionEnd

    return (activeElement as HTMLInputElement).value.slice(start, end)
  }

  return window.getSelection()?.toString()
}

async function sendMessageToCurrentTab(event) {
  console.log('Sending message to current tab...')

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const currentTab = tabs[0]

  if (!currentTab) {
    console.warn('No current tab found. Aborting message send.')
    return
  }

  return chrome.tabs.sendMessage(currentTab.id, event)
}

