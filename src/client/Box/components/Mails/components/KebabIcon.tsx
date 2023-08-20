import { SVGProps } from "react";

const KebabIcon = (props: SVGProps<SVGSVGElement>) => (
  // license = https://fontawesome.com/license
  // ----------------from here----------------
  <svg
    aria-hidden="true"
    focusable="false"
    role="img"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 512 512"
    {...props}
  >
    <path
      fill="currentColor"
      d="M328 256c0 39.8-32.2 72-72 72s-72-32.2-72-72 32.2-72 72-72 72 32.2 72 72zm104-72c-39.8 0-72 32.2-72 72s32.2 72 72 72 72-32.2 72-72-32.2-72-72-72zm-352 0c-39.8 0-72 32.2-72 72s32.2 72 72 72 72-32.2 72-72-32.2-72-72-72z"
    ></path>
  </svg>
  // ----------------until here---------------
  // edit note:
  //// 1. purged unused properties
  //// 2. added passed properties
);

export default KebabIcon;
