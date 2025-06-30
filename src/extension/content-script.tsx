import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { GitHub, Play, Square } from 'react-feather'
import { useState, useEffect } from 'react'
import { Dialog } from '../components/Dialog'
import { OnboardingDialog } from './components/dialogs/OnboardingDialog'
import { Button } from '../components/Button'
import { useMount } from '../hooks/useMount'
import { useSync } from '../hooks/useSync'
import {
  TError,
  createGithubIssueFromError,
  isError,
} from './helpers/error-helpers'

// Event listeners -------------------------------------------------------------
window.addEventListener('load', function () {
  console.log('load')

  const root = document.createElement('div')
  const shadowRoot = root.attachShadow({ mode: 'open' })

  // Fetch the CSS file and replace rem values with px values, this is needed
  // so tailwind styles don't inherit the font size from the page.
  fetch(chrome.runtime.getURL('public/styles.css'))
    .then((response) => {
      if (!response.ok) {
        throw new Error('Network response was not ok')
      }
      return response.text()
    })
    .then((text) => {
      const parsedText = text.replace(/(\d*\.?\d+)rem/g, (match, group) => {
        const pxValue = parseFloat(group) * 16
        return `${pxValue}px`
      })

      const styleEl = document.createElement('style')
      styleEl.textContent = parsedText
      shadowRoot.appendChild(styleEl)

      document.body.appendChild(root)
      createRoot(shadowRoot).render(<ContentScript />)
    })
    .catch((error) => {
      console.error('Failed to load CSS: ', error)
    })
})

// Paragraph button manager ---------------------------------------------------
class ParagraphButtonManager {
  private buttons: Map<Element, HTMLElement> = new Map()
  private currentlyPlaying: Element | null = null
  private hasApiKey: boolean = false

  init(sync?: any) {
    console.log('ParagraphButtonManager initializing...', { sync })
    this.hasApiKey = sync?.apiKey ? true : false
    console.log('API key status:', this.hasApiKey)
    
    // Always add buttons, but they'll show different behavior based on API key
    this.addButtonsToParagraphs()
    this.observePageChanges()
    
    console.log('ParagraphButtonManager initialized')
  }

  private addButtonsToParagraphs() {
    // Find all paragraph-like elements
    const paragraphs = document.querySelectorAll('p, article p, .content p, .post p, .article p, div[role="article"] p')
    
    console.log(`Found ${paragraphs.length} potential paragraphs`)
    
    paragraphs.forEach(paragraph => {
      if (this.shouldAddButton(paragraph)) {
        this.addButton(paragraph)
      }
    })
    
    console.log(`Added buttons to ${this.buttons.size} paragraphs`)
  }

  private shouldAddButton(element: Element): boolean {
    const text = element.textContent?.trim() || ''
    
    // Only add button if paragraph has substantial text (more than 30 characters for easier testing)
    if (text.length < 30) {
      console.log('Skipping paragraph - too short:', text.length)
      return false
    }
    
    // Skip if button already exists
    if (this.buttons.has(element)) {
      console.log('Skipping paragraph - button already exists')
      return false
    }
    
    // Skip if element is not visible
    const style = window.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') {
      console.log('Skipping paragraph - not visible')
      return false
    }
    
    console.log('Adding button to paragraph with text:', text.substring(0, 50) + '...')
    return true
  }

  private addButton(paragraph: Element) {
    console.log('Creating button for paragraph')
    const button = document.createElement('div')
    button.className = 'wavenet-play-button'
    button.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="5,3 19,12 5,21" fill="currentColor"/>
      </svg>
    `
    
    // Style the button
    Object.assign(button.style, {
      position: 'absolute',
      left: '-30px',
      top: '2px',
      width: '24px',
      height: '24px',
      backgroundColor: '#3b82f6',
      color: 'white',
      borderRadius: '12px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer',
      opacity: '0.3',
      transition: 'opacity 0.2s ease',
      zIndex: '1000',
      boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
      border: 'none'
    })

    // Position the paragraph relatively if needed
    const paragraphStyle = window.getComputedStyle(paragraph)
    if (paragraphStyle.position === 'static') {
      (paragraph as HTMLElement).style.position = 'relative'
    }

    // Add hover events
    const showButton = () => button.style.opacity = '1'
    const hideButton = () => {
      if (this.currentlyPlaying !== paragraph) {
        button.style.opacity = '0'
      }
    }

    paragraph.addEventListener('mouseenter', showButton)
    paragraph.addEventListener('mouseleave', hideButton)
    button.addEventListener('mouseenter', showButton)
    button.addEventListener('mouseleave', hideButton)

    // Add click handler
    button.addEventListener('click', (e) => {
      e.stopPropagation()
      this.handleButtonClick(paragraph, button)
    })

    paragraph.appendChild(button)
    this.buttons.set(paragraph, button)
    console.log('Button added successfully to paragraph')
  }

  private async handleButtonClick(paragraph: Element, button: HTMLElement) {
    if (!this.hasApiKey) {
      console.warn('No API key available for text-to-speech')
      // Could show a notification here
      return
    }
    
    const text = paragraph.textContent?.trim() || ''
    console.log('Button clicked, text length:', text.length)
    
    if (this.currentlyPlaying === paragraph) {
      // Stop current playback
      this.stopPlayback()
    } else {
      // Start new playback
      this.stopPlayback() // Stop any existing playback first
      this.startPlayback(paragraph, button, text)
    }
  }

  private startPlayback(paragraph: Element, button: HTMLElement, text: string) {
    this.currentlyPlaying = paragraph
    
    // Update button to show stop icon
    button.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <rect x="6" y="6" width="12" height="12" fill="currentColor"/>
      </svg>
    `
    button.style.opacity = '1'
    button.style.backgroundColor = '#ef4444'

    // Send message to service worker to play audio
    chrome.runtime.sendMessage({
      id: 'readAloud',
      payload: { text }
    }).catch(error => {
      console.error('Failed to send message to service worker:', error)
      this.stopPlayback()
    })
  }

  private stopPlayback() {
    if (this.currentlyPlaying) {
      const button = this.buttons.get(this.currentlyPlaying)
      if (button) {
        // Reset button to play icon
        button.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5,3 19,12 5,21" fill="currentColor"/>
          </svg>
        `
        button.style.backgroundColor = '#3b82f6'
        button.style.opacity = '0'
      }
    }

    this.currentlyPlaying = null
    
    // Send stop message to service worker
    chrome.runtime.sendMessage({
      id: 'stopReading'
    }).catch(error => {
      console.error('Failed to send stop message to service worker:', error)
    })
  }

  private observePageChanges() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const element = node as Element
              // Check if the added node contains paragraphs
              const newParagraphs = element.querySelectorAll('p')
              newParagraphs.forEach(p => {
                if (this.shouldAddButton(p)) {
                  this.addButton(p)
                }
              })
              // Also check if the node itself is a paragraph
              if (element.tagName === 'P' && this.shouldAddButton(element)) {
                this.addButton(element)
              }
            }
          })
        }
      })
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true
    })
  }
}

// React component -------------------------------------------------------------
function ContentScript() {
  const { sync, ready } = useSync()
  const [error, setError] = useState<null | TError>(null)
  const handlers = { setError }

  useEffect(() => {
    if (ready) {
      console.log('Content script ready, initializing paragraph buttons...', { 
        apiKeyValid: sync.apiKeyValid, 
        apiKey: sync.apiKey ? 'present' : 'missing' 
      })
      // Initialize paragraph buttons when ready (will check API key in button manager)
      const buttonManager = new ParagraphButtonManager()
      buttonManager.init(sync)
    }
  }, [ready, sync.apiKeyValid, sync.apiKey])

  async function handleMessages(request, sender, sendResponse) {
    console.log('Handling message...', request, sender, sendResponse)

    if (!request) {
      return
    }

    if (isError(request)) {
      setError(request)

      return
    }
  }

  useMount(function () {
    chrome.runtime.onMessage.addListener(handleMessages)

    return () => chrome.runtime.onMessage.removeListener(handleMessages)
  })

  if (!error || !ready) {
    return null
  }

  if (
    error.errorCode === 'MISSING_API_KEY' ||
    (sync.user && !sync.user.credits)
  ) {
    return <OnboardingDialog onClose={() => setError(null)} />
  }

  return (
    <Dialog
      title={error.errorTitle}
      content={error.errorMessage}
      onClose={() => setError(null)}
      buttons={[
        <Button className="max-w-fit" onClick={() => setError(null)}>
          Close
        </Button>,
        <Button
          className="max-w-fit"
          type="primary"
          Icon={GitHub}
          onClick={() => createGithubIssueFromError(error)}
        >
          Create an issue
        </Button>,
      ]}
    />
  )
}
