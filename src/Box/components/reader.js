const container_accounts = document.getElementById("container-accounts");
const container_mails = document.getElementById("container-mails");

let cache = {};

let working;
const renderAccount = (account) => {
  const head = document.createElement("h3");
  container_accounts.append(head);
  head.classList.add("cursor", "tag");
  head.innerText = account.split("@")[0];
  const number = document.createElement("div");
  fetch(`/api/unreadNo/${account}`)
    .then((r) => r.json())
    .then((r) => {
      if (r) {
        number.classList.add("numberBall");
        number.innerText = r;
        head.append(number);
      }
    });
  head.addEventListener("click", () => {
    if (head.classList.contains("clicked")) return;
    if (working) return;
    working = true;
    document.querySelectorAll(".clicked").forEach((e) => {
      e.classList.remove("clicked");
      e.classList.add("cursor");
    });
    head.classList.add("clicked");
    head.classList.remove("cursor");
    container_mails.style.top = 0 - container_mails.offsetHeight + "px";
    container_mails.classList.add("clipped");
    const showMails = () => {
      const r = cache[account];
      document.querySelectorAll(".mailcard").forEach((e) => e.remove());
      r.forEach((e, i) => {
        r[i].mailcard = renderMail(i, account, { head: head, number: number });
      });
      container_mails.style.top = 0 - container_mails.offsetHeight + "px";
      setTimeout(() => {
        container_mails.style.top = 0;
        container_mails.classList.remove("clipped");
        working = false;
      }, 140);
    };
    setTimeout(() => {
      if (!cache[account]) {
        return fetch(`/api/mails/${account}`)
          .then((r) => r.json())
          .then((r) => {
            cache[account] = r;
            showMails();
          });
      } else {
        showMails();
      }
    }, 140);
  });
};

const createMailContent = (mailcard, html, attachments) => {
  const text = document.createElement("div");
  text.classList.add("hide", "text");
  const attachmentBox = document.createElement("div");
  attachmentBox.classList.add("attachmentBox");
  text.append(attachmentBox);
  if (attachments) {
    attachments.forEach((e) => {
      const attachment = document.createElement("div");
      attachment.innerHTML =
        `<i class="fas fa-file"></i>&nbsp;&nbsp;` + e.filename;
      attachment.classList.add("attachment", "cursor");
      attachmentBox.append(attachment);
      let link;
      attachment.addEventListener("click", () => {
        if (!link) {
          fetch(`/api/attachment/${e.content.data}`)
            .then((r) => r.arrayBuffer())
            .then((r) => {
              link = document.createElement("a");
              const blob = new Blob([r], { type: e.contentType });
              const objectUrl = URL.createObjectURL(blob);
              link.href = objectUrl;
              link.target = "_black";
              link.download = e.filename;
              link.click();
            });
        } else {
          link.click();
        }
      });
    });
  }
  const iframe = document.createElement("iframe");
  iframe.srcdoc = `
  <style>
    body {
      margin: 0;
      overflow-y: hidden;
    }
    * {
      font-family: 'Open Sans';
      color: rgb(70,70,70);
    }
  </style>
  ${html}
  <link href="//fonts.googleapis.com/css?family=Open+Sans:300,400,600,700&amp;subset=latin" rel="stylesheet">
  `;
  iframe.style.height = 0;
  text.append(iframe);
  mailcard.append(text);
  return new Promise((res, rej) => {
    iframe.addEventListener("load", () => {
      res(text);
    });
  });
};

const renderMail = (i, account, head) => {
  const e = cache[account][i];
  if (e.mailcard) {
    container_mails.prepend(e.mailcard);
    return e.mailcard;
  }
  const element = document.createElement("blockquote");
  element.classList.add("mailcard");
  if (!e.read) element.classList.add("unread");
  container_mails.prepend(element);
  const headerBox = document.createElement("div");
  element.append(headerBox);
  const header = document.createElement("div");
  header.classList.add("header", "cursor");
  const date = new Date(e.date).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  const time = new Date(e.date).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit"
  });
  let duration = (Number(Date.now()) - Number(new Date(e.date))) / (1000 * 60);
  if (duration > 2 * 24 * 60) {
    duration = `${Math.floor(duration / (60 * 24))} days ago`;
  } else if (duration > 2 * 60) {
    duration = `${Math.floor(duration / 60)} hours ago`;
  } else if (duration > 2) {
    duration = `${Math.floor(duration)} minutes ago`;
  } else {
    duration = "just now";
  }
  header.innerHTML = `
    <div class="mailcard-small content">${duration}</div>
    <div class="mailcard-small content">${date}, ${time}</div>
    <div class="mailcard-small content">${e.from.text
      .replace("<", "&lt;")
      .replace(">", "&gt;")}</div>
    <div class="mailcard-subject content">${e.subject}</div>
  `;
  headerBox.append(header);

  const onClickHeader = (text) => {
    if (text.classList.contains("hide")) {
      if (!e.read) {
        fetch(`/api/markRead/${e.id}`);
        e.read = true;
        element.classList.remove("unread");
        head.number.innerText -= 1;
        if (head.number.innerText === "0") head.number.remove();
      }
      const openTexts = Array.from(document.querySelectorAll(".text")).filter(
        (e) => {
          return !e.classList.contains("hide");
        }
      );
      openTexts.forEach((e) => {
        if (e === text) return;
        e.children[1].style.height = 0;
        setTimeout(() => {
          e.classList.add("hide");
        }, 130);
      });
      const duration = openTexts.length ? 130 : 0;
      setTimeout(() => {
        text.classList.remove("hide");
        text.children[1].style.height =
          text.children[1].contentWindow.document.body.scrollHeight + 32 + "px";
      }, duration);
      return;
    }
    text.children[1].style.height = 0;
    setTimeout(() => {
      text.classList.add("hide");
    }, 130);
  };

  header.addEventListener("click", () => {
    if (!e.text) {
      fetch(`/api/mailContent/${e.id}`)
        .then((r) => r.json())
        .then((r) => {
          e.html = r.html;
          e.messageId = r.messageId;
          return createMailContent(element, r.html, r.attachments);
        })
        .then((r) => {
          e.text = r;
          onClickHeader(e.text);
        });
    } else if (!e.text.parentElement) {
      element.append(e.text);
      e.text.children[1].addEventListener("load", () => {
        onClickHeader(e.text);
      });
    } else {
      onClickHeader(e.text);
    }
  });

  const actionBox = document.createElement("div");
  actionBox.classList.add("actionBox");
  headerBox.prepend(actionBox);
  const trashBox = document.createElement("div");
  trashBox.classList.add("iconBox");
  const trash = document.createElement("i");
  trash.classList.add("fas", "fa-trash", "cursor");
  trashBox.prepend(trash);
  actionBox.prepend(trashBox);
  trash.addEventListener("click", () => {
    event.stopPropagation();
    const sure = confirm("Do you want to delete this mail?");
    if (sure) {
      fetch(`/api/mails/${e.id}`, { method: "DELETE" }).then((r) => {
        element.remove();
        const mailcards = document.querySelectorAll(".mailcard");
        if (!mailcards.length) head.head.remove();
      });
    }
  });
  const replyBox = document.createElement("div");
  replyBox.classList.add("iconBox");
  const reply = document.createElement("i");
  reply.classList.add("fas", "fa-reply", "cursor");
  replyBox.prepend(reply);
  actionBox.prepend(replyBox);
  reply.addEventListener("click", () => {
    writerContent.classList.remove("flip");
    document.getElementById("writer-from").value = account.split("@")[0];
    document.getElementById("writer-to").value = e.from.value[0].address;
    document.getElementById("writer-cc").value =
      e.cc?.value.reduce((acc, e, i) => {
        if (!acc) return e.address;
        return acc + ", " + e.address;
      }, "") || "";
    document.getElementById("writer-title").value = "RE: " + e.subject;
    if (!e.text) {
      fetch(`/api/mailContent/${e.id}`)
        .then((r) => r.json())
        .then((r) => {
          e.html = r.html;
          e.messageId = r.messageId;
          const date = new Date(e.date).toLocaleDateString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric"
          });
          const time = new Date(e.date).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit"
          });
          const replyHTML = `
          \n\n\n
          <in-reply-to>${e.messageId}<in-reply-to>
          <br><br><br>
          <p>On ${date} at ${time}, ${e.from.text
            .replace("<", "&lt;")
            .replace(">", "&gt;")} wrote:</p>
          <blockquote style="border-left: 1px solid #cccccc; padding-left: 0.5rem; margin-left: 0.5rem">
            ${e.html}
          </blockquote>
        `;
          document.getElementById("writer-textarea").value = replyHTML;
          return createMailContent(element, r.html, r.attachments);
        })
        .then((r) => {
          e.text = r;
        });
    } else {
      const date = new Date(e.date).toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric"
      });
      const time = new Date(e.date).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit"
      });
      const replyHTML = `
        \n\n\n
        <in-reply-to>${e.messageId}<in-reply-to>
        <br><br><br>
        <p>On ${date} at ${time}, ${e.from.text
        .replace("<", "&lt;")
        .replace(">", "&gt;")} wrote:</p>
        <blockquote style="border-left: 1px solid #cccccc; padding-left: 0.5rem; margin-left: 0.5rem">
          ${e.html}
        </blockquote>
      `;
      document.getElementById("writer-textarea").value = replyHTML;
    }
    if (!writerIsShown) toggleWriter();
  });
  return element;
};

let gettingMail;

const getMails = () => {
  if (gettingMail) return;
  gettingMail = true;
  cache = {};
  document.querySelectorAll(".tag").forEach((e) => e.remove());
  document.querySelectorAll(".mailcard").forEach((e) => e.remove());
  fetch("/api/accounts")
    .then((r) => r.json())
    .then((r) => r.forEach(renderAccount))
    .then(() => {
      gettingMail = false;
    });
};

getMails();
