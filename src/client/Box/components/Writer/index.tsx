import {
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  MouseEventHandler
} from "react";

import { useMutation } from "react-query";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import { ApiResponse, SendMailPostBody, SendMailPostResponse } from "server";

import {
  Context,
  useLocalStorage,
  getDateForMailHeader,
  insertStyle
} from "client";

import { CcIcon, SendIcon, AttachIcon, EraserIcon } from "./components";
import FileIcon from "../FileIcon";

import "./index.scss";

const replyDataToOriginalMessage = (replyData: any) => {
  if (!replyData) {
    return {
      id: "",
      messageId: "",
      subject: "",
      prefix: "",
      html: ""
    };
  }
  const { id, messageId, date, subject, from, html } = replyData;

  const { date: localeDate, time: localeTime } = getDateForMailHeader(
    new Date(date)
  );

  const prefix = `On ${localeDate} at ${localeTime}, ${from.text} wrote:`;
  const newHtml = `<blockquote style="border-left: 1px solid #cccccc; padding: 0 0 0 0.5rem; margin: 0 0 0 0.5rem;">${html}</blockquote>`;

  return {
    id: id as string,
    messageId: messageId as string,
    subject: subject as string,
    prefix,
    html: newHtml
  };
};

const getReplyContainerHtml = (originalMessage: any) => {
  const inner =
    `<p>${originalMessage.prefix
      .replace("<", "&lt;")
      .replace(">", "&gt;")}</p>` + originalMessage.html;
  return `<div class="replace_with_details">${inner}</div>`;
};

const Writer = () => {
  const { domainName, isWriterOpen, setIsWriterOpen, replyData, setReplyData } =
    useContext(Context);

  const [isCcOpen, setIsCcOpen] = useLocalStorage("isCcOpen", false);

  const [name, setName] = useLocalStorage("name", "");
  const [to, setTo] = useLocalStorage("to", "");
  const [cc, setCc] = useLocalStorage("cc", "");
  const [bcc, setBcc] = useLocalStorage("bcc", "");
  const [subject, setSubject] = useLocalStorage("subject", "");
  const [sender, setSender] = useLocalStorage("sender", "");
  const [initialContent, setInitialContent] = useLocalStorage(
    "initialContent",
    "Say something really cool here!"
  );
  const [originalMessage, setOriginalMessage] = useLocalStorage(
    "originalMessage",
    {
      id: "",
      messageId: "",
      subject: "",
      html: "",
      prefix: ""
    }
  );
  const [attachments, setAttachments] = useState<any>({});
  const [editorKey, setEditorKey] = useState(1);

  const editor = useEditor({
    extensions: [StarterKit],
    content: initialContent
  });

  const editorRef = useRef(editor);
  editorRef.current = editor;
  editorRef.current?.on("update", (e) => setInitialContent(e.editor.getHTML()));

  const setEditorContent = useCallback(
    (content: string) => {
      editorRef.current?.commands.setContent(content);
      setInitialContent(content);
    },
    [setInitialContent]
  );

  useEffect(() => {
    if (replyData.id && replyData.messageId && setReplyData && isWriterOpen) {
      setSender(replyData.to.address.split("@")[0]);
      setTo(replyData.from.value[0].address);
      setCc(replyData.cc?.value?.map((e: any) => e.address).join(", ") || "");
      setBcc(replyData.bcc?.value?.map((e: any) => e.address).join(", ") || "");

      const replyMarkExistsInSubect = !replyData.subject
        .toLowerCase()
        .indexOf("re:");
      const forwardMarkExistsInSubect = !replyData.subject
        .toLowerCase()
        .indexOf("fwd:");
      const subject = replyData.to.address
        ? replyMarkExistsInSubect
          ? replyData.subject
          : "Re: " + replyData.subject
        : forwardMarkExistsInSubect
        ? replyData.subject
        : "Fwd: " + replyData.subject;
      setSubject(subject);

      const editorContent = replyData.to.address
        ? replyData.insight?.suggested_reply || ""
        : "";

      setEditorContent(editorContent);
      setAttachments({});
      setOriginalMessage(replyDataToOriginalMessage(replyData));

      setReplyData({});
    }
  }, [
    setSender,
    setTo,
    setCc,
    setBcc,
    setSubject,
    setAttachments,
    replyData,
    setReplyData,
    isWriterOpen,
    setOriginalMessage,
    setEditorContent
  ]);

  const sendMail = (data: BodyInit) => {
    return fetch("/api/mails/send", {
      method: "POST",
      headers: {},
      body: data
    }).then((r) => r.json() as unknown as ApiResponse<SendMailPostResponse>);
  };

  const onSuccessSendMail = (data: ApiResponse<SendMailPostResponse>) => {
    if (data.status !== "success") {
      return alert("Failed to send. Please Try again");
    }
    alert("Your mail is sent successfully");
    setIsWriterOpen(false);
    onClickEraserIcon();
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
    setEditorContent("");
    setAttachments({});
    setEditorKey(editorKey + 1);
    setOriginalMessage({
      id: "",
      messageId: "",
      html: "",
      subject: "",
      prefix: ""
    });
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

    const html =
      insertStyle(editor?.getHTML() || "") +
      "\n\n\n" +
      getReplyContainerHtml(originalMessage);

    const mailData: SendMailPostBody = {
      senderFullName: name,
      sender,
      to,
      cc,
      bcc,
      subject,
      html,
      inReplyTo: originalMessage.messageId
    };

    for (const key in mailData) {
      const value = mailData[key as keyof SendMailPostBody];
      if (!value) continue;
      formData.append(key, value);
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

  const onClickPadding: MouseEventHandler<HTMLDivElement> = (e) => {
    const targetClassList = Array.from((e.target as any).classList);
    const targetIsPadding = !!targetClassList.find(
      (f) => f === "editor_container_bottom_padding"
    );
    if (targetIsPadding) editor?.commands.focus();
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
        <div className="inputBox-flex margin_box">
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
        <div className="writer-content-wrap">
          {attachmentComponents.length ? (
            <div className="attachmentBox">{attachmentComponents}</div>
          ) : (
            <></>
          )}
          <div
            className={
              "writer-content margin_box" + (isWriterOpen ? " open" : "")
            }
          >
            <div
              className="editor_container_bottom_padding"
              onClick={onClickPadding}
            >
              <EditorContent editor={editor} />
              {originalMessage.id ? (
                <div
                  className="original_message cursor"
                  onClick={() => setIsWriterOpen(false)}
                >
                  <div className="suffix">{originalMessage.prefix}</div>
                  <div className="subject">
                    <blockquote>{originalMessage.subject}</blockquote>
                  </div>
                </div>
              ) : (
                <></>
              )}
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
