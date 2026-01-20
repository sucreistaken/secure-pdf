# NodeBB Secure PDF Viewer Plugin

A professional, secure, and feature-rich PDF viewer plugin for NodeBB forums. Built on Mozilla's PDF.js, this plugin integrates a powerful PDF reading experience directly into your community.

## 🚀 Features

- **Advanced Annotation Tools**: Highlight text, draw freehand, add text notes, and insert shapes (rectangles, circles, lines, arrows).
- **Persistent Annotations**: Annotations are saved per page and persist across sessions (stored locally or via server implementation).
- **Page Manipulation**: Rotate pages left/right to correct orientation.
- **Reading Modes**: 
  - **Sepia Mode**: Reduces eye strain during long reading sessions.
  - **Dark Mode Support**: UI adapts to system themes.
- **Navigation**:
  - Sidebar with thumbnail navigation.
  - Jump to page.
  - Zoom controls (In, Out, Page Width).
- **Responsive Design**: Mobile-friendly toolbar and sidebar behavior.
- **Security**: Built-in security controls to manage PDF access.

## 📦 Installation

```bash
npm install nodebb-plugin-secure-pdf
```

## 🛠️ Usage

1. **Upload PDF**: Upload a PDF file to a post.
2. **View**: Click on the PDF attachment to open it in the Secure Viewer.
3. **Annotate**: Use the toolbar to select tools (Pen, Highlighter, Text, Shapes).

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `H` | Toggle Highlighter |
| `P` | Toggle Pen |
| `T` | Toggle Text Tool |
| `R` | Toggle Shapes |
| `E` | Eraser |
| `S` | Toggle Sidebar |
| `M` | Toggle Reading Mode |
| `Arrows` | Navigate Pages |

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

This project is licensed under the MIT License.
