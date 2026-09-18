import Markdown from "react-markdown";

export default function MarkdownPreview({ text }: { text: string }) {
  // No raw HTML, embedded remote images, or automatically loaded resources.
  return <Markdown skipHtml components={{
    img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
    a: ({ href, children }) => href && /^https?:\/\//iu.test(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span>{children}</span>,
  }}>{text}</Markdown>;
}
