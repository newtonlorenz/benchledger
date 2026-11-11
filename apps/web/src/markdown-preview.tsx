import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Table } from "./components/ui/table";

export default function MarkdownPreview({ text }: { text: string }) {
  // No raw HTML, embedded remote images, or automatically loaded resources.
  return <Markdown skipHtml remarkPlugins={[remarkGfm]} components={{
    // Wide build tables scroll inside the preview instead of the page.
    table: ({ children }) => <div className="markdown-table-scroll" role="region" aria-label="Table" tabIndex={0}><Table>{children}</Table></div>,
    img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
    a: ({ href, children }) => href && /^https?:\/\//iu.test(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span>{children}</span>,
  }}>{text}</Markdown>;
}
