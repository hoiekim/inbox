import React, { useContext, useState, useEffect } from "react";
import { useMutation } from "react-query";

import CcIcon from "./components/CcIcon";
import PreviewIcon from "./components/PreviewIcon";
import SendIcon from "./components/SendIcon";
import AttachIcon from "./components/AttachIcon";
import FileIcon from "../FileIcon";
import EraserIcon from "./components/EraserIcon";

import { Context } from "../../..";

import "./index.scss";

import marked from "marked";

const domainName = process.env.REACT_APP_DOMAIN || "mydomain";

const cookieSenderName = localStorage.getItem("writer-senderName") || "";

const writerParser = (html) => {
  const htmlComponents = html.split("<in-reply-to>");
  return {
    html: marked(htmlComponents[0]) + (htmlComponents[2] || ""),
    inReplyTo: htmlComponents[1]
  };
};

const Writer = () => {
  const { isWriterOpen, setIsWriterOpen, replyData, setReplyData } =
    useContext(Context);

  const [isCcOpen, setIsCcOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewSrc, setPreviewSrc] = useState("");

  const [name, setName] = useState(cookieSenderName);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [sender, setSender] = useState("");
  const [textarea, setTextarea] = useState("");

  const [attachments, setAttachments] = useState({});

  useEffect(() => {
    if (replyData.id && replyData.messageId && setReplyData && isWriterOpen) {
      const date = new Date(replyData.date).toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric"
      });

      const time = new Date(replyData.date).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit"
      });

      const html = `\n\n\n
<in-reply-to>${replyData.messageId}<in-reply-to>
<br><br><br>
<p>On ${date} at ${time}, ${replyData.from.text
        .replace("<", "&lt;")
        .replace(">", "&gt;")} wrote:</p>
<blockquote style="border-left: 1px solid #cccccc; padding-left: 0.5rem; margin-left: 0.5rem">
${replyData.html}
</blockquote>`;

      setSender(replyData.to.address.split("@")[0]);
      setTo(replyData.from.value[0].address);
      setCc("");
      setBcc("");
      setSubject("RE: " + replyData.subject);
      setTextarea(html);
      setAttachments({});

      setReplyData({});
    }
  }, [replyData, setReplyData, isWriterOpen]);

  const sendMail = (data) => {
    return fetch("/api/send", {
      method: "POST",
      headers: {},
      body: data
    }).then((r) => r.json());
  };

  const onSuccessSendMail = () => {
    alert("Your mail is sent successfully");
    setIsWriterOpen(false);
    setSender("");
    setTo("");
    setCc("");
    setBcc("");
    setSubject("");
    setTextarea("");
    setAttachments({});
  };

  const mutation = useMutation(sendMail, { onSuccess: onSuccessSendMail });

  const onChangeName = (e) => {
    const name = e.target.value;
    setName(name);
    localStorage.setItem("writer-senderName", name);
  };

  const onClickCurtain = () => {
    setIsWriterOpen(true);
  };

  const onClickEraserIcon = () => {
    setSender("");
    setTo("");
    setCc("");
    setBcc("");
    setSubject("");
    setTextarea("");
    setAttachments({});
  };

  const onClickCcIcon = () => {
    setIsCcOpen(!isCcOpen);
  };

  const onClickPreview = () => {
    if (isPreviewOpen) setIsPreviewOpen(false);
    else {
      const { html } = writerParser(textarea);
      setPreviewSrc(`
        <style>
          body {
            padding: 0.5rem;
            margin: 0;
            font-family: "Open Sans", -apple-system, BlinkMacSystemFont,
              "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell",
              "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
          }
        </style>
        ${html}
      `);
      setIsPreviewOpen(true);
    }
  };

  const onClickAttach = () => {
    const fileInput = document.createElement("input");
    fileInput.setAttribute("type", "file");
    fileInput.multiple = true;
    fileInput.click();
    fileInput.addEventListener("change", () => {
      const timeStamp = Date.now();
      const clonedAttachments = { ...attachments };
      const files = Array.from(fileInput.files);
      files.forEach(async (e, i) => {
        clonedAttachments[`${timeStamp}-${i}`] = e;
      });
      setAttachments(clonedAttachments);
    });
  };

  const onClickSend = () => {
    if (!window.confirm("Do you want to send it?")) return;

    const formData = new FormData();

    const { html, inReplyTo } = writerParser(textarea);
    const mailData = { name, sender, to, cc, bcc, subject, html, inReplyTo };

    for (const key in mailData) {
      formData.append(key, mailData[key]);
    }

    for (const key in attachments) {
      formData.append("attachments", attachments[key]);
    }

    mutation.mutate(formData);
  };

  const attachmentComponents = Object.keys(attachments).map((key, i) => {
    const file = attachments[key];

    const onClickRemove = () => {
      const clonedAttachments = { ...attachments };
      delete clonedAttachments[key];
      setAttachments(clonedAttachments);
    };

    return (
      <div
        key={i}
        className="attachment"
        title="Click to remove"
        onClick={onClickRemove}
      >
        <div className="attachment-text cursor">
          <FileIcon />
          <span>{file.name}</span>
        </div>
      </div>
    );
  });

  return (
    <blockquote className="writer">
      <div>
        <div className="fieldName">
          <span>From:</span>
          <span>
            <EraserIcon className="cursor" onClick={onClickEraserIcon} />
          </span>
        </div>
        <input
          className="writer-short"
          placeholder="name"
          autoComplete="off"
          value={name}
          onChange={onChangeName}
        />
        <span className="helper-text"> &lt; </span>
        <input
          className="writer-short"
          placeholder="account"
          autoComplete="off"
          value={sender}
          onChange={(e) => setSender(e.target.value)}
        />
        <span className="helper-text">@{domainName} &gt;</span>
      </div>
      <div>
        <div className="fieldName">
          <span>To: </span>
          <span>
            <CcIcon className="cursor" onClick={onClickCcIcon} />
          </span>
        </div>
        <div className="inputBox-flex">
          <input
            className="writer-long"
            placeholder="to@email.com"
            autoComplete="off"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <input
            className={isCcOpen ? "writer-long" : "writer-long hide"}
            placeholder="cc@email.com"
            autoComplete="off"
            disabled={isCcOpen ? false : true}
            value={cc}
            onChange={(e) => setCc(e.target.value)}
          />
          <input
            className={isCcOpen ? "writer-long" : "writer-long hide"}
            placeholder="bcc@email.com"
            autoComplete="off"
            disabled={isCcOpen ? false : true}
            value={bcc}
            onChange={(e) => setBcc(e.target.value)}
          />
        </div>
      </div>
      <div>
        <div className="fieldName">Subject: </div>
        <input
          className="writer-long"
          placeholder="This is the mail subject"
          autoComplete="off"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      <div className="writer-body">
        <div className="fieldName">
          <span>Content: </span>
          <span>
            <AttachIcon className="cursor" onClick={onClickAttach} />
          </span>
        </div>
        <div id="writer-content-wrap">
          {attachmentComponents.length ? (
            <div className="attachmentBox">{attachmentComponents}</div>
          ) : (
            <></>
          )}
          <div id="writer-content" className={isPreviewOpen ? "flip" : ""}>
            <textarea
              className="writer-fat"
              placeholder="Say something really cool here!"
              autoComplete="off"
              value={textarea}
              onChange={(e) => setTextarea(e.target.value)}
            ></textarea>
            <iframe
              id="writer-preview"
              title="writer-preview"
              className={isPreviewOpen ? "" : "hide"}
              srcDoc={previewSrc}
            ></iframe>
          </div>
        </div>
      </div>
      <div className="writer-buttons">
        <button onClick={onClickPreview}>
          <PreviewIcon />
          <span>Preview</span>
        </button>
        <button onClick={onClickSend}>
          <SendIcon />
          <span>Send</span>
        </button>
      </div>
      <div
        style={{ left: "-3px" }}
        className={isWriterOpen ? "curtain" : "curtain on"}
        onClick={onClickCurtain}
      />
    </blockquote>
  );
};

export default Writer;
