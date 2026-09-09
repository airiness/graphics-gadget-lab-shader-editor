//! A producer reads its request only after its process is assigned to this job.
//! This is descendant lifetime containment, not an untrusted publisher sandbox.
#[cfg(windows)]
pub struct ProducerJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl ProducerJob {
    pub fn attach(child: &std::process::Child) -> std::io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let job = Self(CreateJobObjectW(std::ptr::null(), std::ptr::null()));
            if job.0.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job.0, child.as_raw_handle()) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(job)
        }
    }
    pub fn terminate_and_join(&self) -> std::io::Result<()> {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            if TerminateJobObject(self.0, 1) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let start = std::time::Instant::now();
            loop {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
                if QueryInformationJobObject(
                    self.0,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as _,
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                ) == 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                if info.ActiveProcesses == 0 {
                    return Ok(());
                }
                if start.elapsed().as_secs() >= 10 {
                    return Err(std::io::Error::other(
                        "Producer descendant termination remains unproven",
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    }
}
#[cfg(windows)]
impl Drop for ProducerJob {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() {
                windows_sys::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }
}
