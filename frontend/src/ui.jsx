/* Shared UI: toast notifications and the modal dialog, provided through React context so any
 * component can call `useUI().toast(...)` or `useUI().openModal(<Something/>)`.
 * Keeps the Phase 5 accessibility behaviour: aria-live toasts, role="dialog", focus into the
 * dialog on open, Escape to close. */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const UIContext = createContext(null);
export const useUI = () => useContext(UIContext);

export function UIProvider({ children }) {
  const [toastMsg, setToastMsg] = useState(null);   // { text, isError }
  const [modal, setModal] = useState(null);          // React node
  const timerRef = useRef();

  const toast = useCallback((text, isError = false) => {
    setToastMsg({ text, isError });
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setToastMsg(null), 3000);
  }, []);

  const openModal = useCallback((node) => setModal(node), []);
  const closeModal = useCallback(() => setModal(null), []);

  // Escape closes the dialog (standard dialog behaviour).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeModal]);

  return (
    <UIContext.Provider value={{ toast, openModal, closeModal }}>
      {children}
      {modal && <Modal onClose={closeModal}>{modal}</Modal>}
      {toastMsg && (
        <div className={'toast' + (toastMsg.isError ? ' error' : '')} role="status" aria-live="polite">
          {toastMsg.text}
        </div>
      )}
    </UIContext.Provider>
  );
}

function Modal({ children, onClose }) {
  const ref = useRef();
  // Move keyboard focus into the dialog when it opens.
  useEffect(() => {
    const first = ref.current?.querySelector('input, textarea, select, button');
    first?.focus();
  }, []);
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" ref={ref}>{children}</div>
    </div>
  );
}

/* A modal's standard footer row of buttons. */
export function ModalActions({ children }) {
  return <div className="actions">{children}</div>;
}

/* Status pill used in every table (order/appointment/user status). */
export function Pill({ status }) {
  return <span className={`pill ${status}`}>{String(status).replace('_', ' ')}</span>;
}

/* Placeholder shown while a tab loads or when a list is empty. */
export const Empty = ({ children }) => <div className="empty">{children}</div>;
