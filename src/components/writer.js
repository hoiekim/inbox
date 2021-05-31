const ccInput = document.getElementById("writer-cc");
const bccInput = document.getElementById("writer-bcc");
const eye = document.getElementById("writer-eye");

eye.addEventListener("click", () => {
  ccInput.classList.toggle("hide");
  ccInput.disabled = !ccInput.disabled;
  bccInput.classList.toggle("hide");
  bccInput.disabled = !bccInput.disabled;
  eye.classList.toggle("fa-eye");
  eye.classList.toggle("fa-times");
});

const getUrl = (file) => {
  return new Promise((res) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.addEventListener(
      "load",
      () => {
        res(reader.result);
      },
      false
    );
  });
};

document.getElementById("writer-paperclip").addEventListener("click", () => {
  const fileInput = document.createElement("input");
  fileInput.setAttribute("type", "file");
  fileInput.multiple = true;
  fileInput.click();
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files);
    files.forEach(async (e, i) => {
      if (!cache.writer) cache.writer = { attachments: {} };
      const timeStamp = `${Date.now()}-${i}`;
      cache.writer.attachments[timeStamp] = e;
      let attachmentBox = document.querySelector(
        "#writer-body > .attachmentBox"
      );
      if (!attachmentBox) {
        attachmentBox = document.createElement("div");
        attachmentBox.classList.add("attachmentBox");
        document.getElementById("writer-body").prepend(attachmentBox);
      }
      const attachment = document.createElement("div");
      attachment.classList.add("attachment");
      const attachmentText = document.createElement("div");
      attachmentText.innerHTML =
        `<i class="fas fa-file"></i>&nbsp;&nbsp;` + e.name;
      attachmentText.classList.add("attachment-text", "cursor");
      const url = await getUrl(e);
      const preview = document.createElement("iframe");
      preview.classList.add("attachment-preview", "clipped");
      if (e.type.includes("image")) {
        preview.srcdoc = `<img src="${url}" width="100%"/>`;
      } else if (e.type) {
        preview.src = url;
      } else {
        e.text().then((r) => {
          preview.srcdoc = `<div>${r}</div>`;
        });
      }
      attachment.append(preview);
      attachment.append(attachmentText);
      attachment.addEventListener("mouseover", () => {
        preview.classList.remove("clipped");
      });
      attachment.addEventListener("mouseleave", () => {
        preview.classList.add("clipped");
      });
      attachment.addEventListener("click", () => {
        preview.classList.add("clipped");
        attachmentText.style.width = attachmentText.offsetWidth + "px";
        attachmentText.style.height = attachmentText.offsetHeight + "px";
        attachmentText.style.width = 0;
        delete cache.writer.attachments[timeStamp];
        setTimeout(() => {
          attachment.remove();
        }, 150);
      });
      attachment.setAttribute("title", "Click to remove");
      attachmentBox.append(attachment);
    });
  });
});

document.getElementById("writer-send").addEventListener("click", async () => {
  if (!confirm("Do you want to send it?")) return;
  const formData = new FormData();

  const name = document.getElementById("writer-name").value;
  const sender = document.getElementById("writer-from").value;
  const to = document.getElementById("writer-to").value;
  const cc = ccInput.classList.contains("hide") ? null : ccInput.value;
  const bcc = bccInput.classList.contains("hide") ? null : bccInput.value;
  const subject = document.getElementById("writer-title").value;
  const { html, inReplyTo } = writerParser(
    document.getElementById("writer-textarea").value
  );
  const mailData = {
    name,
    sender,
    to,
    cc,
    bcc,
    subject,
    html,
    inReplyTo
  };
  Object.keys(mailData).forEach((e) => {
    formData.append(e, mailData[e]);
  });

  const attachments = cache.writer && Object.values(cache.writer.attachments);
  if (attachments?.length) {
    attachments.forEach((e) => {
      formData.append("attachments", e);
    });
  }

  const result = await fetch("/api/send", {
    method: "POST",
    headers: {},
    body: formData
  }).then((r) => r.text());
  if (result === '"done"') {
    alert("Your mail is sent successfully");
    document.querySelectorAll("input, textarea").forEach((e) => {
      e.value = "";
    });
    document.querySelector("#writer-body > .attachmentBox").innerHTML = "";
    cache.writer = null;
    toggleWriter();
    writerContent.classList.remove("flip");
  } else {
    alert("Email delivery has failed. Please try again.");
  }
});

const writerParser = (html) => {
  const htmlComponents = html.split("<in-reply-to>");
  return {
    html: marked(htmlComponents[0]) + (htmlComponents[2] || ""),
    inReplyTo: htmlComponents[1]
  };
};

const writerContent = document.getElementById("writer-content");
const writerPreview = document.getElementById("writer-preview");
let flipping;
document.getElementById("writer-previewBtn").addEventListener("click", () => {
  if (flipping) return;
  flipping = true;
  writerContent.classList.toggle("flip");
  setTimeout(() => {
    writerPreview.classList.toggle("hide");
  }, 150);
  setTimeout(() => {
    flipping = false;
  }, 600);
  if (!writerContent.classList.contains("flip")) return;
  const { html } = writerParser(
    document.getElementById("writer-textarea").value
  );
  document.getElementById("writer-preview").srcdoc = `
      <style>
        body {
          margin: 0;
        }
        * {
          font-family: 'Open Sans';
          color: rgb(70,70,70);
        }
      </style>
      ${html}
      <link href="//fonts.googleapis.com/css?family=Open+Sans:300,400,600,700&amp;subset=latin" rel="stylesheet">
    `;
});

const writerTextarea = document.getElementById("writer-textarea");
const writerContentWrap = document.getElementById("writer-content-wrap");
const writerResizer = new ResizeObserver((e) => {
  writerContentWrap.style.height = e[0].target.style.height;
});
writerResizer.observe(writerTextarea);
const writer = document.getElementById("container-writer");
const titleBar = document.getElementById("title_bar");
container.style.top = -16 + titleBar.offsetHeight - writer.offsetHeight + "px";

let writerIsShown;

const toggleWriter = () => {
  writerContent.classList.remove("flip");
  if (writerIsShown) {
    writerIsShown = false;
    container.style.top =
      -16 + titleBar.offsetHeight - writer.offsetHeight + "px";
    writer.classList.add("clipped");
  } else {
    writerIsShown = true;
    writer.classList.remove("clipped");
    container.style.top = 4 + titleBar.offsetHeight + "px";
  }
};

document.getElementById("write").addEventListener("click", toggleWriter);
