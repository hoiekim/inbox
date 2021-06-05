import React, { useContext, useState, useEffect } from "react";
import { useMutation } from "react-query";

import CcIcon from "./components/CcIcon";
import PreviewIcon from "./components/PreviewIcon";
import SendIcon from "./components/SendIcon";
import AttachIcon from "./components/AttachIcon";
import FileIcon from "../FileIcon";

import { Context } from "../../..";

import "./index.scss";

import marked from "marked";

const domainName = process.env.REACT_APP_DOMAIN || "mydomain";

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

const writerParser = (html) => {
  const htmlComponents = html.split("<in-reply-to>");
  return {
    html: marked(htmlComponents[0]) + (htmlComponents[2] || ""),
    inReplyTo: htmlComponents[1]
  };
};

const Writer = () => {
  const { isWriterOpen, setIsWriterOpen } = useContext(Context);
  const [isCcOpen, setIsCcOpen] = useState(false);

  const [name, setName] = useState("");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [sender, setSender] = useState("");
  const [textarea, setTextarea] = useState("");

  const [attachments, setAttachments] = useState({});

  const mutation = useMutation((data) => {
    return fetch("/api/send", {
      method: "POST",
      headers: {},
      body: data
    }).then((r) => r.json());
  });

  const swiperStyle = {};

  if (isWriterOpen) {
    swiperStyle.right = 0;
  } else swiperStyle.right = "calc(500px - 100vw)";

  const onClickCurtain = () => {
    setIsWriterOpen(true);
  };

  const onClickCcIcon = () => {
    setIsCcOpen(!isCcOpen);
  };

  const onClickPreview = () => {};

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

  useEffect(() => {
    if (mutation.status === "success") {
      alert("Your mail is sent successfully");
      setIsWriterOpen(false);
      setName("");
      setSender("");
      setTo("");
      setCc("");
      setBcc("");
      setSubject("");
      setTextarea("");
      setAttachments({});
    }
  }, [mutation.status]);

  const Attachments = () => {
    const result = Object.keys(attachments).map((key, i) => {
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
    return result ? <div className="attachmentBox">{result}</div> : <></>;
  };

  return (
    <blockquote className="writer" style={swiperStyle}>
      <div>
        <div className="fieldName">From: </div>
        <input
          className="writer-short"
          placeholder="name"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
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
          <Attachments />
          <div id="writer-content">
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
              className="hide"
            ></iframe>
          </div>
        </div>
      </div>
      <div id="writer-buttons-wrap">
        <button id="writer-previewBtn" className="writer-buttons">
          <PreviewIcon className="cursor" onClick={onClickPreview} />
          <span>Preview</span>
        </button>
        <button
          id="writer-send"
          className="writer-buttons"
          onClick={onClickSend}
        >
          <SendIcon className="cursor" />
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
