import React, { useContext, useState, useEffect } from "react";
import { useMutation } from "react-query";

import Editor, { theme } from "rich-markdown-editor";

import { CcIcon, SendIcon, AttachIcon, EraserIcon } from "./components";
import FileIcon from "../FileIcon";

import { Context, useLocalStorage } from "src";
import { useDarkTheme } from "src/lib";

import "./index.scss";

import { marked } from "marked";

const domainName = process.env.REACT_APP_DOMAIN || "mydomain";

const writerParser = (html: any) => {
  const htmlComponents = html.split("<in-reply-to>");
  return {
    html:
      marked(htmlComponents[0].replace(/\n/g, "<br/>\n")) +
      (htmlComponents[2] || ""),
    inReplyTo: htmlComponents[1] || ""
  };
};

const Writer = () => {
  const { isWriterOpen, setIsWriterOpen, replyData, setReplyData } =
    useContext(Context);

  const [isCcOpen, setIsCcOpen] = useLocalStorage("isCcOpen", false);

  const [name, setName] = useLocalStorage("name", "");
  const [to, setTo] = useLocalStorage("to", "");
  const [cc, setCc] = useLocalStorage("cc", "");
  const [bcc, setBcc] = useLocalStorage("bcc", "");
  const [subject, setSubject] = useLocalStorage("subject", "");
  const [sender, setSender] = useLocalStorage("sender", "");
  const [textarea, setTextarea] = useLocalStorage("textarea", "");

  const [attachments, setAttachments] = useState<any>({});

  const [editorValue, setEditorValue] = useState(textarea);

  const isDarkTheme = useDarkTheme();

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
<blockquote style="border-left: 1px solid #cccccc; padding-left: 0.5rem; padding-right: 0; margin-left: 0.5rem; margin-right: 0;">
${replyData.html}
</blockquote>`;

      setSender(replyData.to.address.split("@")[0]);
      setTo(replyData.from.value[0].address);
      setCc("");
      setBcc("");
      setSubject(replyData.subject);
      setTextarea(html);
      setAttachments({});

      setReplyData({});
    }
  }, [
    setSender,
    setTo,
    setCc,
    setBcc,
    setSubject,
    setTextarea,
    setAttachments,
    replyData,
    setReplyData,
    isWriterOpen
  ]);

  const sendMail = (data: any) => {
    return fetch("/api/send", {
      method: "POST",
      headers: {},
      body: data
    }).then((r) => r.json());
  };

  const onSuccessSendMail = (data: any) => {
    if (data !== true) return alert("Failed to send. Please Try again");
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

  const onChangeName = (e: any) => {
    const name = e.target.value;
    setName(name);
  };

  const onClickEraserIcon = () => {
    setSender("");
    setTo("");
    setCc("");
    setBcc("");
    setSubject("");
    setTextarea("");
    setAttachments({});
    setEditorValue("");
    console.log(editorValue);
  };

  const onClickCcIcon = () => {
    setIsCcOpen(!isCcOpen);
  };

  const onClickAttach = () => {
    const fileInput = document.createElement("input");
    fileInput.setAttribute("type", "file");
    fileInput.multiple = true;
    fileInput.click();
    fileInput.addEventListener("change", () => {
      const timeStamp = Date.now();
      const clonedAttachments: any = { ...attachments };
      const files = Array.from(fileInput.files as unknown as any[]);
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

    const mailData: any = {
      name,
      sender,
      to,
      cc,
      bcc,
      subject,
      html,
      inReplyTo
    };

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
        className="attachment cursor"
        title="Click to remove"
        onClick={onClickRemove}
      >
        <FileIcon />
        <span>{file.name}</span>
      </div>
    );
  });

  const editorBackgroundColor = isWriterOpen
    ? theme.background
    : isDarkTheme
    ? "#2d3537"
    : "#f2f2f2";

  const editorColor = isWriterOpen
    ? theme.text
    : isDarkTheme
    ? "#f2f2f2"
    : "#2d3537";

  let focusAtEnd: () => void = () => {};

  const onClickPadding: React.MouseEventHandler<HTMLDivElement> = (e) => {
    const targetClassList = Array.from((e.target as any).classList);
    const targetIsContainer = targetClassList.find(
      (f) => f === "editor_container"
    );
    if (targetIsContainer) focusAtEnd();
  };

  const uploadImage = async (file: File) => {
    const blob = new Blob([file]);
    const objectUrl = URL.createObjectURL(blob);
    return objectUrl;
  };

  return (
    <blockquote className="writer">
      <div>
        <div className="fieldName">
          <span>From:</span>
          <span>
            <EraserIcon className="cursor" onClick={onClickEraserIcon} />
          </span>
        </div>
        <div className="margin_box inputBox-flex">
          <input
            className="writer-short"
            placeholder="name"
            autoComplete="off"
            value={name}
            onChange={onChangeName}
          />
          <div className="from_address">
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
        </div>
      </div>
      <div>
        <div className="fieldName">
          <span>To: </span>
          <span>
            <CcIcon className="cursor" onClick={onClickCcIcon} />
          </span>
        </div>
        <div className="inputBox-flex margin_box">
          <input
            className="writer-long"
            placeholder="to-1@email.com, to-2@email.com"
            autoComplete="off"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <input
            className={isCcOpen ? "writer-long" : "writer-long hide"}
            placeholder="cc-1@email.com, cc-2@email.com"
            autoComplete="off"
            disabled={isCcOpen ? false : true}
            value={cc}
            onChange={(e) => setCc(e.target.value)}
          />
          <input
            className={isCcOpen ? "writer-long" : "writer-long hide"}
            placeholder="bcc-1@email.com, bcc-2@email.com"
            autoComplete="off"
            disabled={isCcOpen ? false : true}
            value={bcc}
            onChange={(e) => setBcc(e.target.value)}
          />
        </div>
      </div>
      <div>
        <div className="fieldName">Subject: </div>
        <div className="margin_box">
          <input
            className="writer-long"
            placeholder="This is the mail subject"
            autoComplete="off"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
      </div>
      <div className="writer-body">
        <div className="fieldName">
          <span>Content: </span>
          <span>
            <AttachIcon className="cursor" onClick={onClickAttach} />
          </span>
        </div>
        <div className="writer-content-wrap margin_box">
          {attachmentComponents.length ? (
            <div className="attachmentBox">{attachmentComponents}</div>
          ) : (
            <></>
          )}
          <div
            className="writer-content-padding"
            style={{
              backgroundColor: editorBackgroundColor
            }}
          >
            <div
              className="writer-content"
              onClick={onClickPadding}
              style={{
                backgroundColor: editorBackgroundColor
              }}
            >
              <Editor
                className="editor_container"
                ref={(e) => {
                  if (e?.focusAtEnd) focusAtEnd = e.focusAtEnd;
                }}
                style={{
                  height: "100%",
                  justifyContent: "flex-start",
                  backgroundColor: editorBackgroundColor,
                  color: editorColor,
                  overflowY: "scroll",
                  overflowX: "visible",
                  paddingLeft: "2rem"
                }}
                theme={{
                  ...theme,
                  background: editorBackgroundColor,
                  text: editorColor
                }}
                placeholder="Say something really cool here!"
                defaultValue={textarea}
                value={editorValue}
                onChange={setTextarea}
                uploadImage={uploadImage}
              />
            </div>
          </div>
        </div>
      </div>
      <div className="writer-buttons">
        <button onClick={onClickSend}>
          <SendIcon />
          <span>Send</span>
        </button>
      </div>
    </blockquote>
  );
};

export default Writer;
