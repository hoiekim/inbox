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

  const timerRef = useRef<NodeJS.Timeout | null>(null);

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

  useEffect(() => {
    // Initial setup with delay for iframe to load
    timerRef.current = setTimeout(() => {
      audjstMailContnetSize(iframeElement.current);
    }, 300);

    return () =>
      timerRef.current ? clearTimeout(timerRef.current) : undefined;
  }, [audjstMailContnetSize]);

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
      audjstMailContnetSize(iframeDom);

      if (!iframeDom || !iframeDom.contentWindow) return;
      const content = iframeDom.contentWindow.document.body;
      if (!content) return;

      content.addEventListener("click", () => {
        setTimeout(() => audjstMailContnetSize(iframeDom), 50);
      });
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
