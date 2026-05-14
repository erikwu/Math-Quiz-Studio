document.addEventListener("DOMContentLoaded", () => {
  const submitButton = document.querySelector("[data-submit-quiz]");
  if (submitButton) {
    submitButton.addEventListener("click", (event) => {
      const unanswered = Number(submitButton.getAttribute("data-unanswered") || "0");
      const message =
        unanswered > 0
          ? `You still have ${unanswered} unanswered question(s). Submit anyway?`
          : "Submit your paper now?";

      if (!window.confirm(message)) {
        event.preventDefault();
      }
    });
  }

  document.querySelectorAll("[data-confirm]").forEach((button) => {
    button.addEventListener("click", (event) => {
      const message = button.getAttribute("data-confirm") || "Are you sure?";
      if (!window.confirm(message)) {
        event.preventDefault();
      }
    });
  });

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

  document.querySelectorAll("[data-modal-open]").forEach((button) => {
    button.addEventListener("click", () => {
      const modalId = button.getAttribute("data-modal-open");
      openModal(document.getElementById(modalId));
    });
  });

  document.querySelectorAll("[data-modal-close]").forEach((button) => {
    button.addEventListener("click", () => {
      closeModal(button.closest(".modal-backdrop"));
    });
  });

  document.querySelectorAll(".modal-backdrop").forEach((modal) => {
    modal.addEventListener("click", (event) => {
      if (event.target === modal) {
        closeModal(modal);
      }
    });
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
