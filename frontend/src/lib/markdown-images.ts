interface MarkdownNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
}

function onlyImages(node: MarkdownNode): boolean {
  if (node.type === "text") return !node.value?.trim();
  if (node.tagName === "img" || node.tagName === "br") return true;
  return node.tagName === "a" && Boolean(node.children?.length) && node.children!.every(onlyImages);
}

function imageParagraph(node: MarkdownNode): boolean {
  return node.tagName === "p" && Boolean(node.children?.some(child => child.tagName === "img" || child.tagName === "a")) && node.children!.every(onlyImages);
}

export function groupMarkdownImages() {
  return (tree: MarkdownNode) => {
    const visit = (parent: MarkdownNode) => {
      if (!parent.children) return;
      if (parent.tagName === "a") for (const child of parent.children) {
        if (child.tagName === "img") child.properties = { ...child.properties, "data-linked-image": true };
      }
      const grouped: MarkdownNode[] = [];
      for (let index = 0; index < parent.children.length; index++) {
        const node = parent.children[index];
        if (!imageParagraph(node)) { visit(node); grouped.push(node); continue; }
        visit(node);
        const images = (paragraph: MarkdownNode) => paragraph.children!.filter(child => child.type !== "text" && child.tagName !== "br");
        const gallery = { ...node, properties: { ...node.properties, className: ["markdown-image-gallery"] }, children: images(node) };
        while (index + 1 < parent.children.length) {
          let next = index + 1;
          while (parent.children[next]?.type === "text" && !parent.children[next].value?.trim()) next++;
          if (!parent.children[next] || !imageParagraph(parent.children[next])) break;
          visit(parent.children[next]);
          gallery.children.push(...images(parent.children[next]));
          index = next;
        }
        if (gallery.children.length > 1) {
          const markGalleryImage = (child: MarkdownNode) => {
            if (child.tagName === "img") child.properties = { ...child.properties, "data-gallery-image": true };
            child.children?.forEach(markGalleryImage);
          };
          gallery.children.forEach(markGalleryImage);
        }
        grouped.push(gallery);
      }
      parent.children = grouped;
    };
    visit(tree);
  };
}
