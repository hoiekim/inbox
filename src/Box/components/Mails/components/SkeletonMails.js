import React from "react";

const SkeletonMails = () => {
  return (
    <>
      <blockquote className="mailcard skeleton">
        <div style={{ width: 70 + 50 * Math.random() }}></div>
        <div style={{ width: 200 + 20 * Math.floor(3 * Math.random()) }}></div>
        <div style={{ width: 120 + 120 * Math.floor(3 * Math.random()) }}></div>
        <div style={{ width: 120 + 120 * Math.floor(3 * Math.random()) }}></div>
        <div
          style={{ width: 70 + 10 * Math.floor(3 * Math.random()) + "%" }}
        ></div>
      </blockquote>
    </>
  );
};

export default SkeletonMails;
