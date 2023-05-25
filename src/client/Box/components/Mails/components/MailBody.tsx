import React, { useState, useContext, useEffect, useRef } from "react";
import { useQuery } from "react-query";

import { Context, ContextType } from "client";
import FileIcon from "client/Box/components/FileIcon";

import { Attachment, MailBodyType } from "server";

interface Props {
  mailId: string;
  isSummaryOpen: boolean;
}

const MailBody = ({ mailId, isSummaryOpen }: Props) => {
  const { setIsWriterOpen, replyData, setReplyData } = useContext(
    Context
  ) as ContextType;

  const [isLoadingIframe, setIsLoadingIframe] = useState(true);

  const queryUrl = `/api/mail-body/${mailId}`;

  const getMail = () => fetch(queryUrl).then((r) => r.json());
  const query = useQuery<MailBodyType>(queryUrl, getMail);

  const iframeElement = useRef(null);

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

  useEffect(() => {
    setTimeout(() => audjstMailContnetSize(iframeElement.current), 300);
  }, []);

  const audjstMailContnetSize = (iframeDom: HTMLIFrameElement | null) => {
    if (!iframeDom || !iframeDom.contentWindow) return;
    const content = iframeDom.contentWindow.document.body;
    if (!content) return;
    const contentHeight = content.scrollHeight;
    const contentWidth = content.scrollWidth;
    const adjustedContentWidth = iframeDom.offsetWidth - 16;
    const scale = adjustedContentWidth / contentWidth;
    const adjustedContentHeight = scale * contentHeight;
    const adjustedClientHeight = adjustedContentHeight + 32;

    content.style.transform = `scale(${scale})`;
    content.style.position = "absolute";
    content.style.top = (adjustedContentHeight * (1 - scale)) / -2 + "px";
    content.style.left = (adjustedContentWidth * (1 - scale)) / -2 + "px";

    iframeDom.style.transition = adjustedClientHeight / 3 + "ms";
    iframeDom.style.height = adjustedClientHeight + "px";
    iframeDom.style.paddingTop = "8px";
    iframeDom.style.paddingBottom = "24px";
  };

  const loadingMessage = "Loading Mail Data...";

  if (query.isLoading) {
    return <div className="text">{loadingMessage}</div>;
  }

  if (query.error) {
    return <div className="text">Mail Data Request Failed</div>;
  }

  const data = query.data;

  if (query.isSuccess && data) {
    const attachments: JSX.Element[] = data.attachments?.map(
      (attachment: Attachment, i: number) => {
        const onClickAttachment = () => {
          fetch(`/api/attachment/${attachment.content.data}`)
            .then((r) => r.arrayBuffer())
            .then((r) => {
              const link = document.createElement("a");
              const blob = new Blob([r], { type: attachment.contentType });
              const objectUrl = URL.createObjectURL(blob);
              link.href = objectUrl;
              link.target = "_black";
              link.download = attachment.filename;
              return link;
            })
            .then((link) => link.click());
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

    const iframeSrcDoc = `
<style>
  body {
      margin: 0;
      overflow: hidden;
      width: 100%;
      height: 100%
  }
  * {
      font-family: "Open Sans", -apple-system, BlinkMacSystemFont, "Segoe UI",
      "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans",
      "Helvetica Neue", sans-serif;
      color: rgb(70,70,70);
  }
</style>
${data.html}
<script>
  Array.from(document.querySelectorAll("a")).forEach((e) => {
    const target = e.getAttribute("target")
    if (!target || target[0] === "_") e.setAttribute("target", "_blank")
  })
</script>
`;

    const onLoadIframe: React.ReactEventHandler<HTMLIFrameElement> = (e) => {
      setIsLoadingIframe(false);
      audjstMailContnetSize(e.target as HTMLIFrameElement);
    };

    const summary = data.insight?.summary?.map((e) => {
      return <li>{e}</li>;
    });

    const actionItems = data.insight?.action_items?.map((e) => {
      return <li>{e}</li>;
    });

    return (
      <div className="text">
        <div className="loading_message">
          {isLoadingIframe && !isSummaryOpen ? loadingMessage : null}
        </div>
        {attachments && attachments.length ? (
          <div className="attachmentBox">{attachments}</div>
        ) : (
          <></>
        )}
        {isSummaryOpen ? (
          <div>
            {!!summary?.length && (
              <div className="summary">
                <ul>{summary}</ul>
              </div>
            )}
            {!!actionItems?.length && (
              <div className="actionItem">
                <ul>{actionItems}</ul>
              </div>
            )}
          </div>
        ) : (
          <iframe
            title={mailId}
            srcDoc={iframeSrcDoc}
            onLoad={onLoadIframe}
            ref={iframeElement}
          />
        )}
      </div>
    );
  }

  return <></>;
};

export default MailBody;
