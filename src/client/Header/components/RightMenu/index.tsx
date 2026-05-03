import { useContext } from "react";
import { Context, onKeyboardActivate } from "client";
import WriteIcon from "./components/WriteIcon";

const RightMenu = () => {
  const { isWriterOpen, setIsWriterOpen } = useContext(Context);

  const onClickWriter = () => {
    setIsWriterOpen(!isWriterOpen);
  };

  return (
    <div
      className="menu right cursor"
      role="button"
      tabIndex={0}
      aria-label={isWriterOpen ? "Close compose" : "Compose new mail"}
      onClick={onClickWriter}
      onKeyDown={onKeyboardActivate(onClickWriter)}
    >
      <div id="write" className="iconBox">
        <WriteIcon />
      </div>
    </div>
  );
};

export default RightMenu;
