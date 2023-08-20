const SkeletonMails = () => {
  return (
    <>
      <blockquote className="mailcard skeleton loading_animation">
        <div style={{ width: 90 + 20 * Math.random() }}></div>
        <div style={{ width: 200 + 20 * Math.floor(3 * Math.random()) }}></div>
        <div style={{ width: 240 + 120 * Math.floor(2 * Math.random()) }}></div>
        <div style={{ width: 120 + 120 * Math.floor(3 * Math.random()) }}></div>
        <div
          style={{ width: "min(" + (200 + 200 * Math.random()) + "px, 90%)" }}
        ></div>
      </blockquote>
    </>
  );
};

export default SkeletonMails;
