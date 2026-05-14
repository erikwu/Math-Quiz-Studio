document.addEventListener("DOMContentLoaded", () => {
  const body = document.body;

  const closeModal = (modal) => {
    if (!modal) {
      return;
    }

    modal.hidden = true;
    body.classList.remove("modal-open");
  };

  const openModal = (modal) => {
    if (!modal) {
      return;
    }

    modal.hidden = false;
    body.classList.add("modal-open");
  };

  document.addEventListener("click", (event) => {
    const submitButton = event.target.closest("[data-submit-quiz]");
    if (submitButton) {
      const unanswered = Number(submitButton.getAttribute("data-unanswered") || "0");
      const message =
        unanswered > 0
          ? `You still have ${unanswered} unanswered question(s). Submit anyway?`
          : "Submit your paper now?";

      if (!window.confirm(message)) {
        event.preventDefault();
      }
      return;
    }

    const confirmButton = event.target.closest("[data-confirm]");
    if (confirmButton) {
      const message = confirmButton.getAttribute("data-confirm") || "Are you sure?";
      if (!window.confirm(message)) {
        event.preventDefault();
      }
      return;
    }

    const openButton = event.target.closest("[data-modal-open]");
    if (openButton) {
      const modalId = openButton.getAttribute("data-modal-open");
      openModal(document.getElementById(modalId));
      return;
    }

    const closeButton = event.target.closest("[data-modal-close]");
    if (closeButton) {
      closeModal(closeButton.closest(".modal-backdrop"));
      return;
    }

    if (event.target.classList.contains("modal-backdrop")) {
      closeModal(event.target);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }

    const activeModal = document.querySelector(".modal-backdrop:not([hidden])");
    if (activeModal) {
      closeModal(activeModal);
    }
  });
});
