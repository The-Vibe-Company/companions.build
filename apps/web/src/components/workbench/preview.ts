import { previewDocument } from "../../../../../packages/workbench/artifacts";

const tags = new Set("html head body title style div span main section article header footer nav aside h1 h2 h3 h4 h5 h6 p a ul ol li dl dt dd blockquote pre code strong em b i u s small br hr img figure figcaption table thead tbody tfoot tr td th caption colgroup col button label input textarea select option details summary time sup sub".split(" "));
const attributes = new Set("class id style title alt width height colspan rowspan scope role aria-label aria-hidden type placeholder value disabled checked selected open datetime".split(" "));

/** Parse in an inert template, then serialize only an allowlist. Never attach source nodes to the app. */
export function safePreviewDocument(html: string): string {
  previewDocument(html); // Bounds before parsing.
  const template = document.createElement("template");
  template.innerHTML = html;
  const clean = (parent: DocumentFragment | Element) => {
    for (const node of [...parent.children]) {
      if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || !tags.has(node.localName)) { node.remove(); continue; }
      for (const attribute of [...node.attributes]) {
        // No navigation, remote media, handlers, srcdoc, form actions, custom elements or embedded documents.
        const inlineImage = node.localName === "img" && attribute.name === "src" && /^data:image\/(png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=]+$/.test(attribute.value);
        if (!attributes.has(attribute.name) && !inlineImage) node.removeAttribute(attribute.name);
      }
      clean(node);
    }
  };
  clean(template.content);
  return previewDocument(template.innerHTML);
}
