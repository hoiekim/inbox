import {
  useContext,
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  MouseEventHandler
} from "react";

import { useMutation } from "react-query";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";

import {
  ApiResponse,
  BodyGetResponse,
  SendMailPostBody,
  SendMailPostResponse
} from "server";

import {
  Context,
  useLocalStorage,
  processHtmlToSendMail,
  call,
  useIsOnline
} from "client";

import { CcIcon, SendIcon, AttachIcon, EraserIcon } from "./components";
import FileIcon from "../FileIcon";

import {
  OriginalMessage,
  OriginalMessageMeta,
  EMPTY_ORIGINAL_META,
  wrapQuoteHtml,
  replyDataToOriginalMessage,
  getReplyContainerHtml
} from "./lib";

import "./index.scss";

const Writer = () => {
  const {
    domainName,
    isWriterOpen,
    setIsWriterOpen,
    replyData,
    setReplyData
  } = useContext(Context);

  const { isOnline } = useIsOnline();

  const [isCcOpen, setIsCcOpen] = useLocalStorage("isCcOpen", false);

  const [name, setName] = useLocalStorage("name", "");
  const [to, setTo] = useLocalStorage("to", "");
  const [cc, setCc] = useLocalStorage("cc", "");
  const [bcc, setBcc] = useLocalStorage("bcc", "");
  const [subject, setSubject] = useLocalStorage("subject", "");
  const [sender, setSender] = useLocalStorage("sender", "");
  const [initialContent, setInitialContent] = useLocalStorage(
    "initialContent",
    ""
  );
  // Persist only the mail identifier + small labels. The quoted HTML
  // stays in-memory (see `originalMessageHtml` below) — it's re-fetched
  // on mount from `/api/mails/body/{id}` if a reply was in progress
  // when the tab closed. This is the resolution of #668: the previous
  // fix stopped persisting `originalMessage` altogether (so a close-
  // reopen dropped the reply target too); now the id survives while
  // the payload stays off localStorage.
  const [originalMessageMeta, setOriginalMessageMeta] =
    useLocalStorage<OriginalMessageMeta>(
      "originalMessageMeta",
      EMPTY_ORIGINAL_META
    );
  const [originalMessageHtml, setOriginalMessageHtml] = useState<string>("");
  const originalMessage = useMemo<OriginalMessage>(
    () => ({ ...originalMessageMeta, html: originalMessageHtml }),
    [originalMessageMeta, originalMessageHtml]
  );
  const setOriginalMessage = useCallback(
    (m: OriginalMessage) => {
      const { html, ...meta } = m;
      setOriginalMessageMeta(meta);
      setOriginalMessageHtml(html);
    },
    [setOriginalMessageMeta]
  );

  // Always-current id, read inside the async re-fetch below to drop a stale
  // resolve (the user may switch replies / clear the form mid-fetch).
  const latestMetaId = useRef(originalMessageMeta.id);
  latestMetaId.current = originalMessageMeta.id;

  const [attachments, setAttachments] = useState<Record<string, File>>({});
  const [editorKey, setEditorKey] = useState(1);

  // Reclaim quota for browsers that already have a large stale value stored
  // under `originalMessage` from before the payload moved off localStorage
  // (#668). The new `originalMessageMeta` key holds only small strings.
  useEffect(() => {
    localStorage.removeItem("originalMessage");
  }, []);

  // Rehydrate the quoted HTML when a reply was in progress.
  // `originalMessageMeta.id` survives close/reopen via localStorage; the HTML is
  // pulled from the mail body endpoint so it never has to sit in storage. Re-runs
  // when the id changes or the user reconnects, so an offline reopen fills the
  // quote once back online — otherwise a Send before then ships the attribution
  // line over an empty blockquote (Send only gates on `isOnline`, not the fetch).
  // Silent no-op if the mail is gone server-side; the compose form still opens
  // with the draft fields, only the quoted block is missing.
  useEffect(() => {
    const id = originalMessageMeta.id;
    if (!id || originalMessageHtml || !isOnline) return;
    call
      .get<BodyGetResponse>(`/api/mails/body/${id}`)
      .then((r) => {
        // Drop a stale resolve: the user may have switched to a different reply
        // or cleared the form while this fetch was in flight — applying this
        // body over another reply's meta/prefix would mismatch the quote.
        if (latestMetaId.current !== id) return;
        if (r.status === "success" && r.body?.html) {
          setOriginalMessageHtml(wrapQuoteHtml(r.body.html));
        }
      })
      .catch(console.error);
  }, [originalMessageMeta.id, originalMessageHtml, isOnline]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: "Say something really cool here!",
      }),
    ],
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
      setSender(replyData.to?.address?.split("@")[0] || "");
      setTo(replyData.from?.value?.[0]?.address || "");
      setCc(replyData.cc?.value?.map((e) => e.address).join(", ") || "");
      setBcc(replyData.bcc?.value?.map((e) => e.address).join(", ") || "");

      const subjectLower = (replyData.subject || "").toLowerCase();
      const replyMarkExistsInSubect = subjectLower.indexOf("re:") === 0;
      const forwardMarkExistsInSubect = subjectLower.indexOf("fwd:") === 0;
      const originalSubject = replyData.subject || "";
      const subject = replyData.to?.address
        ? replyMarkExistsInSubect
          ? originalSubject
          : "Re: " + originalSubject
        : forwardMarkExistsInSubect
        ? originalSubject
        : "Fwd: " + originalSubject;
      setSubject(subject);

      const editorContent = replyData.to?.address
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

  const sendMail = (data: FormData) => {
    return call.postFormData<SendMailPostResponse>("/api/mails/send", data);
  };

  const onSuccessSendMail = (data: ApiResponse<SendMailPostResponse>) => {
    if (data.status !== "success") {
      return alert(data.message || "Failed to send. Please try again.");
    }
    alert("Your mail is sent successfully");
    setIsWriterOpen(false);
    onClickEraserIcon();
  };

  const mutation = useMutation(sendMail, { onSuccess: onSuccessSendMail });

  const onChangeName = (e: React.ChangeEvent<HTMLInputElement>) => {
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
      const clonedAttachments: Record<string, File> = { ...attachments };
      const files = Array.from(fileInput.files || []);
      files.forEach((file, i) => {
        clonedAttachments[`${timeStamp}-${i}`] = file;
      });
      setAttachments(clonedAttachments);
    });
  };

  const onClickSend = () => {
    if (!sender.trim()) return alert("Please enter a sender account name.");
    if (!to.trim()) return alert("Please enter a recipient email address.");
    if (!window.confirm("Do you want to send it?")) return;

    const formData = new FormData();

    const html =
      processHtmlToSendMail(editor?.getHTML() || "") +
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
    const target = e.target as HTMLElement;
    const targetClassList = Array.from(target.classList);
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
        <button
          onClick={onClickSend}
          disabled={!isOnline}
          title={
            isOnline ? undefined : "You're offline — reconnect to send mail"
          }
        >
          <SendIcon />
          <span>Send</span>
        </button>
      </div>
    </blockquote>
  );
};

export default Writer;
