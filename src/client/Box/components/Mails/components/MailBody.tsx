import {
  useState,
  useContext,
  useEffect,
  useRef,
  ReactEventHandler,
  useCallback
} from "react";
import { useQuery } from "react-query";
import { AttachmentType, MailBodyData } from "common";
import { BodyGetResponse } from "server";
import { Context, ContextType, call, processHtmlForViewer } from "client";
import FileIcon from "client/Box/components/FileIcon";

interface Props {
  mailId: string;
}

const replaceBlockquoteWithDetails = (text: string, blockquote: Element) => {
  const details = window.document.createElement("details");
  details.innerHTML =
    "<summary>" +
    text.replace("<", "&lt;").replace(">", "&gt;") +
    "</summary>" +
    "<hr/>" +
    blockquote.innerHTML;
  details.style.marginTop = "16px";
  blockquote.parentNode?.replaceChild(details, blockquote);
  return details;
};

const MailBody = ({ mailId }: Props) => {
  const { setIsWriterOpen, replyData, setReplyData } = useContext(
    Context
  ) as ContextType;

  const [isLoadingIframe, setIsLoadingIframe] = useState(true);

  const queryUrl = `/api/mails/body/${mailId}`;

  const getMail = async () => {
    const { status, body, message } = await call.get<BodyGetResponse>(queryUrl);
    if (status === "success") return new MailBodyData(body);
    else throw new Error(message);
  };
  const query = useQuery<MailBodyData>(queryUrl, getMail);

  const iframeElement = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (
      query.data?.html &&
      replyData.id === query.data.id &&
      replyData.messageId !== query.data.messageId
    ) {
      setReplyData({
        ...replyData,
        html: query.data.html,
        messageId: query.data.messageId
      });
      setIsWriterOpen(true);
    }
  }, [setIsWriterOpen, replyData, setReplyData, query]);

  const audjstMailContnetSize = useCallback(
    (iframeDom: HTMLIFrameElement | null) => {
      if (!iframeDom || !iframeDom.contentWindow) return;
      const content = iframeDom.contentWindow.document.body;
      if (!content) return;

      // Reset iframe height to auto to get accurate content measurements
      iframeDom.style.height = "auto";

      const contentHeight = content.scrollHeight;
      const contentWidth = content.scrollWidth;
      const adjustedContentWidth = iframeDom.offsetWidth - 24;
      const scale = adjustedContentWidth / contentWidth;
      const adjustedContentHeight = scale * contentHeight;
      const adjustedClientHeight = adjustedContentHeight + 32;

      content.style.transform = `scale(${scale})`;
      content.style.position = "absolute";
      content.style.top = (adjustedContentHeight * (1 - scale)) / -2 + "px";
      content.style.left = (adjustedContentWidth * (1 - scale)) / -2 + "px";

      iframeDom.style.height = adjustedClientHeight + "px";
      iframeDom.style.paddingTop = "8px";
      iframeDom.style.paddingBottom = "24px";
    },
    []
  );

  const loadingMessage = "Loading Mail Data...";

  if (query.isLoading) {
    return <div className="text">{loadingMessage}</div>;
  }

  if (query.error) {
    return <div className="text">Mail Data Request Failed</div>;
  }

  const data = query.data;

  if (query.isSuccess && data) {
    const attachments: JSX.Element[] | undefined = data.attachments?.map(
      (attachment: AttachmentType, i: number) => {
        const onClickAttachment = () => {
          fetch(`/api/mails/attachment/${attachment.content.data}`)
            .then((r) => r.arrayBuffer())
            .then((buffer) => {
              const link = document.createElement("a");
              const blob = new Blob([buffer], { type: attachment.contentType });
              const objectUrl = URL.createObjectURL(blob);
              link.href = objectUrl;
              link.target = "_black";
              link.download = attachment.filename;
              link.click();
            })
            .catch(console.error);
        };
        return (
          <div
            key={i}
            className="attachment cursor"
            onClick={onClickAttachment}
          >
            <FileIcon />
            <span>{attachment.filename}</span>
          </div>
        );
      }
    );

    const onLoadIframe: ReactEventHandler<HTMLIFrameElement> = (e) => {
      setIsLoadingIframe(false);

      const iframeDom = e.target as HTMLIFrameElement;

      if (!iframeDom || !iframeDom.contentWindow) return;
      const content = iframeDom.contentWindow.document.body;
      if (!content) return;

      content.addEventListener("click", () => {
        setTimeout(() => audjstMailContnetSize(iframeDom), 50);
      });

      Array.from(content.querySelectorAll("a")).forEach((e) => {
        const target = e.getAttribute("target");
        if (!target || target[0] === "_") e.setAttribute("target", "_blank");
        const text = e.innerText.replaceAll("\\n", " ");
        e.innerText = text.length > 50 ? text.substring(0, 47) + "..." : text;
      });

      Array.from(content.querySelectorAll("div, p, blockquote"))
        .reverse()
        .forEach((e) => {
          const children = Array.from(e.childNodes);
          const firstTextNodeIndex = children.findIndex(
            (node) =>
              node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
          );
          // @ts-ignore
          const lastTextNodeIndex = children.findLastIndex(
            // @ts-ignore
            (node) =>
              node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
          );

          const text = children
            .slice(firstTextNodeIndex, lastTextNodeIndex + 1)
            .map((node) => node.textContent)
            .join(" ")
            .trim();

          const regex = /^On.*wrote:/;
          if (regex.test(text)) {
            if (e.nodeName === "BLOCKQUOTE") {
              replaceBlockquoteWithDetails(text, e);
            } else {
              let sibling = e.nextElementSibling;
              while (sibling) {
                if (sibling.matches("blockquote")) break;
                sibling = sibling.nextElementSibling;
              }
              if (sibling && sibling.nodeName === "BLOCKQUOTE") {
                replaceBlockquoteWithDetails(text, sibling);
                e.parentNode?.removeChild(e);
              } else {
                const blockquote = e.querySelector("blockquote");
                if (blockquote) replaceBlockquoteWithDetails(text, blockquote);
              }
            }
            for (let i = firstTextNodeIndex; i <= lastTextNodeIndex; i++) {
              if (children[i]) e.removeChild(children[i]);
            }
          }
        });

      audjstMailContnetSize(iframeDom);
    };

    return (
      <div className="text">
        <div className="loading_message">
          {isLoadingIframe ? loadingMessage : null}
        </div>
        {attachments && attachments.length ? (
          <div className="attachmentBox">{attachments}</div>
        ) : (
          <></>
        )}
        <iframe
          title={mailId}
          srcDoc={processHtmlForViewer(data.html)}
          onLoad={onLoadIframe}
          ref={iframeElement}
        />
      </div>
    );
  }

  return <></>;
};

export default MailBody;
