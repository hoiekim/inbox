import React, { useContext, useEffect, useRef } from "react";
import { useQuery } from "react-query";

import FileIcon from "../../../FileIcon";

import { Context } from "../../../../..";

const MailBody = ({ mailId }) => {
  const { setIsWriterOpen, replyData, setReplyData } = useContext(Context);

  const queryUrl = `/api/mail-body/${mailId}`;

  const getMail = () => fetch(queryUrl).then((r) => r.json());
  const query = useQuery(queryUrl, getMail);

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

  if (query.isLoading) {
    return <div className="text">Loading Mail Data...</div>;
  }

  if (query.error) {
    return <div className="text">Mail Data Request Failed</div>;
  }

  const data = query.data;

  if (query.isSuccess && data) {
    const attachments = data.attachments?.map((attachment, i) => {
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
        <div key={i} className="attachment cursor" onClick={onClickAttachment}>
          <FileIcon />
          <span>{attachment.filename}</span>
        </div>
      );
    });

    const iframeSrcDoc = `
<style>
    body {
        margin: 0;
        overflow-y: hidden;
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
    const targetValue = e.getAttribute("target")
    if (!targetValue || targetValue[0] === "_") e.setAttribute("target", "_blank")
  })
</script>
`;

    const onLoadIframe = (e) => {
      try {
        const iframeDom = e.target;
        if (!iframeDom) return;
        const iframeContent = iframeDom.contentWindow.document.body;
        const iframeContentHeight = iframeContent.scrollHeight;
        iframeDom.style.height = `calc(2rem + ${iframeContentHeight + 32}px)`;
      } catch (err) {
        console.error(err);
      }
    };

    setTimeout(() => onLoadIframe({ target: iframeElement.current }), 300);

    return (
      <div className="text">
        {attachments && attachments.length ? (
          <div className="attachmentBox">{attachments}</div>
        ) : (
          <></>
        )}
        <iframe
          title={mailId}
          srcDoc={iframeSrcDoc}
          onLoad={onLoadIframe}
          ref={iframeElement}
        />
      </div>
    );
  }
};

export default MailBody;
