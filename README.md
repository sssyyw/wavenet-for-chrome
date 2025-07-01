# Wavenet for Chrome

[Chrome extension](https://chrome.google.com/webstore/detail/wavenet-for-chrome/iefankigbnlnlaolflbcopliocibkffc?hl=en) that transforms highlighted text into high-quality natural sounding audio using [Google Cloud's Text-to-Speech](https://cloud.google.com/text-to-speech).

## Features

- Support for all Google WaveNet, Neural2, News, Studio, Polyglot voices and languages.
- Adjustable pitch and speed.
- Download selected text to an MP3 file.
- [SSML support](https://developers.google.com/actions/reference/ssml)
- Shortcut to read aloud (`Cmd+Shift+S` on macOS and `Ctrl+Shift+S` on windows)
- Shortcut to download selected text (`Cmd+Shift+E` on macOS and `Ctrl+Shift+E` on windows)
- **Paragraph play buttons** - Hover over paragraphs to see play buttons for quick text-to-speech (can be toggled in preferences)
- Chunk selected text into sentences to bypass the 5000 character limit and lower usage cost.
- Use your own [Google Cloud API key](https://www.youtube.com/watch?v=1n8xlVNWEZ0) for direct Google Cloud TTS integration.

### Usage Costs

Your usage will be billed through your Google Cloud account according to their [pricing policy](https://cloud.google.com/text-to-speech/pricing). You'll need to provide your own Google Cloud API key to use the extension.

## Development

Interested in contributing? Follow these steps to set up your development environment:

1. Install dependencies with `npm install`.
2. Start the development server for the extension with `npm run start:extension`.
3. To run the website locally, use `npm run start:website`.

After running these commands, load the unpacked extension from the `dist` folder to your Chrome browser.

### Building for Production

To create a production build:

```bash
npm run build:extension
```

This will create a `dist` folder with the built extension and generate a release zip file in the `releases` folder.

## License

This project is licensed under the [MIT License](/LICENSE).
