import { KeyboardEvent, useContext } from "react";
import { Context } from "client";
import WriteIcon from "./components/WriteIcon";

const RightMenu = () => {
  const { isWriterOpen, setIsWriterOpen } = useContext(Context);

  const onClickWriter = () => {
    setIsWriterOpen(!isWriterOpen);
  };

  return (
    <div
      className="menu right cursor"
      onClick={onClickWriter}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClickWriter();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={isWriterOpen ? "Close compose" : "Compose new email"}
    >
      <div id="write" className="iconBox">
        <WriteIcon />
      </div>
    </div>
  );
};

export default RightMenu;
