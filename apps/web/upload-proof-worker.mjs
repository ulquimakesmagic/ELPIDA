import {solveUploadAdmission} from './upload-proof.mjs';
self.onmessage=async event=>{try{self.postMessage({headers:await solveUploadAdmission(event.data)});}catch(error){self.postMessage({error:error.message});}};
