import React, { useState } from 'react';
import TextArea from './TextArea';
import Button from './Button';
import { Link } from 'react-router-dom';
import feedbackService from '../../services/feedbackService';
import { useAuth } from '../../contexts/AuthContext';

const FeedbackButton = () => {
  const { currentUser } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage('');
    setMessageType('');

    if (!feedbackText) {
      setMessage('Please enter feedback text.');
      setMessageType('error');
      return;
    }

    try {
      await feedbackService.createFeedback({ feedbackText });
      setMessage('Feedback submitted successfully!');
      setMessageType('success');
      setFeedbackText('');
      setTimeout(() => setIsOpen(false), 2000);
    } catch (error) {
      console.error('Error submitting feedback:', error);
      setMessage('Failed to submit feedback. Please try again.');
      setMessageType('error');
    }
  };

  return (
    <div className="relative z-50">
      <button
        onClick={() => setIsOpen(true)}
        className="bg-red-600 hover:bg-red-700 text-white font-medium py-2 px-4 rounded-md transition duration-300 ease-in-out"
      >
        Feedback
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-2 bg-white p-6 rounded-lg shadow-xl w-80 border">
          <button
            onClick={() => setIsOpen(false)}
            className="absolute top-2 right-2 text-gray-500 hover:text-gray-700 text-xl"
          >
            &times;
          </button>
          <h3 className="text-lg font-semibold mb-1">Submit Feedback</h3>
          {currentUser && (
            <p className="text-sm text-gray-500 mb-4">Submitting as <span className="font-medium">{currentUser.name}</span></p>
          )}
          <form onSubmit={handleSubmit}>
            <div className="mb-4">
              <TextArea
                label="Feedback"
                name="feedbackText"
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                rows="4"
                required
              />
            </div>
            {message && (
              <p className={`mb-4 text-center ${messageType === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                {message}
              </p>
            )}
            <Button type="submit" className="w-full">
              Submit
            </Button>
          </form>
          <div className="text-center mt-4">
            <Link to="/feedback" className="text-blue-600 hover:underline" onClick={() => setIsOpen(false)}>
              View All Feedback
            </Link>
          </div>
        </div>
      )}
    </div>
  );
};

export default FeedbackButton;
