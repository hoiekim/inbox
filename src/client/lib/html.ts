export const insertStyle = (html: string) => {
  const document = window.document.createElement("div");
  document.innerHTML = html;
  document.querySelectorAll("*").forEach((e) => {
    const anyE = e as any;
    anyE.style.fontWeight = "normal";
  });
  document.querySelectorAll("p, ul, ol").forEach((e) => {
    const anyE = e as any;
    anyE.style.marginTop = "0.5rem";
    anyE.style.marginBottom = "0.5rem";
  });
  document.querySelectorAll("blockquote").forEach((e) => {
    const anyE = e as any;
    anyE.style.marginTop = "10px";
    anyE.style.marginBottom = "10px";
    anyE.style.padding = "0 0 0 0.5rem";
    anyE.style.borderLeft = "5px solid #888";
  });
  document.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((e) => {
    const anyE = e as any;
    anyE.style.fontWeight = "bolder";
  });
  document.querySelectorAll("code").forEach((e) => {
    const anyE = e as any;
    anyE.style.backgroundColor = "#eee";
    anyE.style.color = "#c50";
    anyE.style.borderRadius = "2px";
  });
  document.querySelectorAll("pre").forEach((e) => {
    const anyE = e as any;
    anyE.style.backgroundColor = "#444";
    anyE.style.color = "#fff";
    anyE.style.borderRadius = "3px";
    anyE.style.padding = "0.5rem";
  });
  document.querySelectorAll("pre > code").forEach((e) => {
    const anyE = e as any;
    anyE.style.color = "inherit";
    anyE.style.background = "none";
    anyE.style.padding = 0;
  });
  return document.innerHTML;
};
